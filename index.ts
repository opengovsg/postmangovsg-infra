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
const isProd = env === 'prod'
const baseUrl = 'postman.gov.sg'
export const domainName = isProd ? baseUrl : `${env}.${baseUrl}`

// ======================================== VPC =========================================
const vpc = new Vpc(name, {
  isProd,
  secondOctet: 27,
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
