# Starter Kit Infra

## Setup

If you are here after running [create-ogp-app](https://github.com/opengovsg/create-ogp-app), you are all good to go! Just wait for the first Github Action run to finish:

![Running CI](/docs/running-ci.png)

This would take ~20 minutes. Once it is done, go to `{shortAppName}-stg.beta.gov.sg` (can be updated at `domainName` in `index.ts` later) to see your app.

If you would prefer to set this up as a raw template, read the [first time setup guide](./docs/first-time-setup.md).

## Branching

Follow the [OGP Branching practices](https://github.com/opengovsg/engineering-practices/blob/develop/source-control/branching.md).

- `staging`: the PR is checked against `staging` environment, **deploy to `staging` on merge**
- `production` (create when moving to production): the PR is checked against `production` environment, **deploy to `production` on merge**
