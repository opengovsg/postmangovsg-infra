import {
  Ecs,
  EcsWorker,
  loadAwsProviderDefaultTags,
  MemoryDbRedisCluster,
  SecurityGroupConnection,
  Vpc,
} from '@opengovsg/pulumi-components'
import * as aws from '@pulumi/aws'
import * as pulumi from '@pulumi/pulumi'

const config = new pulumi.Config()
const ecsConfig = config.getObject('ecs') as Partial<{
  server?: {
    minCapacity: number
    maxCapacity: number
  }
  worker?: {
    minCapacity: number
    maxCapacity: number
  }
}>
const memoryDbConfig = config.getObject('memorydb') as {
  nodeType?: string
}

export const { env, project, team } = loadAwsProviderDefaultTags()

// Having env in every name makes multiple env (e.g. prod + stg) in one AWS account possible
const name = 'postman'
const isProd = env === 'production'
const baseUrl = 'postman.gov.sg'
export const domainName = isProd ? baseUrl : `${env}.${baseUrl}`
const region = pulumi.output(aws.getRegion())
const callerIdentity = pulumi.output(aws.getCallerIdentity({}))

const legacyPostman = {
  cidr: '10.102.0.0/16',
  dbSecurityGroupId: 'sg-091f82cc09ba464ce',
  vpcId: 'vpc-006dc4e0a97146e40',
  // only putting storage layer routes here, expand as needed
  vpcRouteTableIds: [
    'rtb-0ba4119d843bd1697',
    'rtb-0f98c74e98527f860',
    'rtb-01366426a89b70b3e',
  ],
}

// ======================================== VPC =========================================

const vpc = new Vpc(name, {
  isProd,
  secondOctet: 27,
})

const vpcPeeringConnection = new aws.ec2.VpcPeeringConnection(name, {
  accepter: { allowRemoteVpcDnsResolution: true },
  autoAccept: true,
  peerVpcId: legacyPostman.vpcId,
  requester: { allowRemoteVpcDnsResolution: true },
  vpcId: vpc.id,
})

// 6 and 9 seems magical 🥲 6 = 2 AZs * 3 layers (edge/compute/storage), 9 = 3 AZs * 3 layers for prod
// Can think about improving this later
for (let i = 0; i < (isProd ? 9 : 6); i++) {
  new aws.ec2.Route(`${name}-${i}`, {
    routeTableId: vpc.xVpc.routeTables[i].id,
    destinationCidrBlock: legacyPostman.cidr,
    vpcPeeringConnectionId: vpcPeeringConnection.id,
  })
}

legacyPostman.vpcRouteTableIds.forEach((routeTableId, i) => {
  new aws.ec2.Route(`${name}-reverse-${i}`, {
    routeTableId,
    destinationCidrBlock: vpc.cidrBlock,
    vpcPeeringConnectionId: vpcPeeringConnection.id,
  })
})
// ========================== ECS (including LB) + CF/ACM cert ==========================
const ecr = new aws.ecr.Repository(
  name,
  {
    name,
    // TODO: (temporary) enable forceDelete to make teardown easier
    forceDelete: true,
  },
  {
    // must delete before replace, otherwise the specified ECR name above will cause conflict
    deleteBeforeReplace: true,
  },
)
export const ecrUri = ecr.repositoryUrl

const ecs = new Ecs(name, {
  loadBalancingArgs: {
    allowCloudFlareOriginatedTraffic: true,
    allowOgpVpnOriginatedTraffic: true,
  },
  scalingArgs: {
    minCapacity: ecsConfig?.server?.minCapacity ?? undefined,
    maxCapacity: ecsConfig?.server?.maxCapacity ?? undefined,
  },
  deploymentArgs: {
    deploymentConfigName: 'CodeDeployDefault.ECSAllAtOnce',
    terminationWaitTimeInMinutes: isProd ? 10 : 0,
  },
  vpc,
})
export const lbUrl = ecs.loadBalancer.dnsName

// ========================== ECS (Worker) ==========================

// Deploy an ECS Service on Fargate to host worker containers
const worker = new EcsWorker(name, {
  vpc,
  cluster: ecs.cluster,
  scalingArgs: {
    minCapacity: ecsConfig?.worker?.minCapacity ?? undefined,
    maxCapacity: ecsConfig?.worker?.maxCapacity ?? undefined,
  },
})

// ========== Role policy for getting secrets from Secrets Manager ==============
// needed because we are injecting secrets into the container via environment variables
const ecsSecretsManagerRolePolicy = new aws.iam.RolePolicy(
  'ecs-secrets-policy',
  {
    role: ecs.taskRole,
    policy: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'secretsmanager:GetSecretValue',
          Resource: pulumi.interpolate`arn:aws:secretsmanager:${region.name}:${callerIdentity.accountId}:secret:*`,
        },
        {
          Effect: 'Allow',
          Action: 'rds-db:connect',
          Resource: pulumi.interpolate`arn:aws:rds-db:${region.name}:${callerIdentity.accountId}:dbuser:*/flamingo_iam`,
        },
      ],
    },
  },
)
const workerSecretsManagerRolePolicy = new aws.iam.RolePolicy(
  'worker-secrets-policy',
  {
    role: worker.taskRole,
    policy: {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'secretsmanager:GetSecretValue',
          Resource: pulumi.interpolate`arn:aws:secretsmanager:${region.name}:${callerIdentity.accountId}:secret:*`,
        },
        {
          Effect: 'Allow',
          Action: 'rds-db:connect',
          Resource: pulumi.interpolate`arn:aws:rds-db:${region.name}:${callerIdentity.accountId}:dbuser:*/flamingo_iam`,
        },
      ],
    },
  },
)

// Enable ECS egress traffic on port 465 (SMTPS) to send emails via AWS SES

const ecsSmtpsEgressRule = new aws.ec2.SecurityGroupRule('ecsSmtpsEgressRule', {
  type: 'egress',
  fromPort: 465,
  toPort: 465,
  protocol: 'tcp',
  cidrBlocks: ['0.0.0.0/0'],
  securityGroupId: ecs.taskSecurityGroup.id,
  description: 'Allow ECS to call AWS SES to send emails',
})

const workerSmtpsEgressRule = new aws.ec2.SecurityGroupRule(
  'workerSmtpsEgressRule',
  {
    type: 'egress',
    fromPort: 465,
    toPort: 465,
    protocol: 'tcp',
    cidrBlocks: ['0.0.0.0/0'],
    securityGroupId: worker.securityGroup.id,
    description: 'Allow ECS to call AWS SES to send emails',
  },
)

// ========================== Log Groups ==========================
const serverLogs = new aws.cloudwatch.LogGroup(`${name}-server-logs`, {
  name: `${name}/ecs/application-server`, // Matched by log group specified in task definition
  retentionInDays: 0, // infinity
})

const workerLogs = new aws.cloudwatch.LogGroup(`${name}-worker-logs`, {
  name: `${name}/ecs/application-worker`, // Matched by log group specified in task definition
  retentionInDays: 0, // infinity
})

new aws.cloudwatch.LogGroup(`${name}-server-dd-logs`, {
  name: `${name}/dd-agent/server`, // Matched by log group specified in task definition
  retentionInDays: 0, // infinity
})

new aws.cloudwatch.LogGroup(`${name}-worker-dd-logs`, {
  name: `${name}/dd-agent/worker`, // Matched by log group specified in task definition
  retentionInDays: 0, // infinity
})

// ======================================== RDS =========================================
// Set security group for ecs to RDS
// new SecurityGroupConnection(`${name}-ecs-task-to-rds`, {
//   description: 'Allow traffic from ECS Task to RDS',
//   fromSg: ecs.taskSecurityGroup,
//   toSg: rds.securityGroup,
//   port: 5432,
// })

// Set security group for ecs worker to RDS
// new SecurityGroupConnection(`${name}-ecs-worker-task-to-rds`, {
//   description: 'Allow traffic from ECS Worker Task to RDS',
//   fromSg: worker.securityGroup,
//   toSg: rds.securityGroup,
//   port: 5432,
// })

new SecurityGroupConnection(`${name}-ecs-task-to-old-redis`, {
  description: 'Allow traffic from ECS Task to old Redis',
  fromSg: ecs.taskSecurityGroup,
  toSgId: legacyPostman.dbSecurityGroupId,
  port: 6379,
})

new SecurityGroupConnection(`${name}-ecs-worker-to-old-redis`, {
  description: 'Allow traffic from ECS Worker to old Redis',
  fromSg: worker.securityGroup,
  toSgId: legacyPostman.dbSecurityGroupId,
  port: 6379,
})

new SecurityGroupConnection(`${name}-ecs-task-to-old-rds`, {
  description: 'Allow traffic from ECS Task to old RDS',
  fromSg: ecs.taskSecurityGroup,
  toSgId: legacyPostman.dbSecurityGroupId,
  port: 5432,
})

new SecurityGroupConnection(`${name}-ecs-worker-to-old-rds`, {
  description: 'Allow traffic from ECS Worker to old RDS',
  fromSg: worker.securityGroup,
  toSgId: legacyPostman.dbSecurityGroupId,
  port: 5432,
})

// ======================================= Redis =========================================

const redis = new MemoryDbRedisCluster(`${name}-redis`, {
  vpc,
  nodeType: memoryDbConfig.nodeType,
  clusterArgs: {
    numReplicasPerShard: 1,
  },
})

export const redisUrl = redis.clusterAddress

// Set security group for ecs to Redis
new SecurityGroupConnection(`${name}-ecs-task-to-redis`, {
  description: 'Allow traffic from ECS Task to Redis',
  fromSg: ecs.taskSecurityGroup,
  toSg: redis.securityGroup,
  port: redis.clusterPort,
})

// Set security group for ecs worker to Redis
new SecurityGroupConnection(`${name}-ecs-worker-task-to-redis`, {
  description: 'Allow traffic from ECS Worker Task to Redis',
  fromSg: worker.securityGroup,
  toSg: redis.securityGroup,
  port: redis.clusterPort,
})
