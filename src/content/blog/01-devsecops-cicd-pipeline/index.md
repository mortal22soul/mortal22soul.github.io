---
title: "Building an End to End DevSecOps CI/CD Pipeline"
description: "How I built a CI/CD pipeline for a Node.js app with Jenkins, Docker, Kubernetes, ArgoCD, Sealed Secrets, SonarQube, Trivy, OWASP ZAP, and AWS infrastructure on Terraform."
date: "Sep 18 2025"
demoURL: ""
repoURL: "https://github.com/mortal22soul/e2e-cicd-pipeline"
---

# Building an end-to-end DevSecOps CI/CD pipeline

I built this because I got tired of pipelines that were little more than a fancy way to run `npm install && docker push`. A passing build says nothing about known CVEs in the image or vulnerabilities that have accumulated in its dependencies.

I wanted security checks inside the process rather than bolted on afterward. The application is a small Node.js API about planets. I kept it simple because the pipeline is the interesting part.

## The app

The Solar System API is a Node.js and Express application backed by MongoDB. Its `/live` endpoint handles health checks, while `/planet` returns planet data. That is the whole application. There is no business logic to distract from what happens in the pipeline.

The Dockerfile stays small on purpose:

```dockerfile
FROM node:24.8-alpine3.21

WORKDIR /usr/app
COPY package*.json /usr/app/
RUN npm install
COPY . .

ENV MONGO_URI=uriPlaceholder
ENV MONGO_USERNAME=usernamePlaceholder
ENV MONGO_PASSWORD=passwordPlaceholder

EXPOSE 8000
CMD [ "npm", "start" ]
```

I use Alpine to keep the image small. The placeholder environment variables document what the container needs. Jenkins supplies the real values at runtime, so they never enter an image layer. If a secret does enter a layer, someone can retrieve it with `docker history` even after a later layer changes it.

## Pipeline structure

The `Jenkinsfile` defines a declarative pipeline. The triggering branch selects one of three paths:

| Branch      | What happens                                              |
| ----------- | --------------------------------------------------------- |
| `feature/*` | Build → scan → deploy to EC2 → integration test           |
| `PR*`       | Build → scan → update GitOps repo → DAST → upload reports |
| `main`      | Build → scan → deploy to Lambda → smoke test              |

These global settings prevent stalled or overlapping jobs:

```groovy
options {
    timeout(time: 1, unit: 'HOURS')
    disableResume()
    disableConcurrentBuilds abortPrevious: true
}
```

`disableConcurrentBuilds abortPrevious: true` has saved me the most trouble. If I push twice to the same branch in quick succession, Jenkins cancels the first run instead of running both. My self-hosted Jenkins instance has limited memory, so overlapping builds can make it unresponsive.

## Security scanning

I have seen plenty of pipelines called "DevSecOps" because they run one SAST scan. That is too thin to be useful. This pipeline runs five checks against the dependencies, source code, built image, and live application.

### Parallel dependency scanning

Two scans run in parallel immediately after `npm install`.

`npm audit` runs with `--audit-level=critical` for a quick check of known vulnerable packages. It logs its result but does not fail the stage because Dependency-Check is the actual gate.

OWASP Dependency-Check compares every package with the NIST vulnerability database. Its first run downloads the full database and takes a while. Later runs use the cached data and finish much faster. I configured it like this:

```groovy
dependencyCheck additionalArguments: '''
    --scan ./
    --format "ALL"
    --out ./
    --prettyPrint "ALL"
    --disableYarnAudit
''', odcInstallation: 'owasp-dep-check-12-1-2'

dependencyCheckPublisher(
    failedTotalCritical: 4,
    pattern: 'dependency-check-report.xml',
    stopBuild: true
)
```

The build stops if the scan finds more than four critical issues. `--format "ALL"` produces HTML, JSON, XML, and JUnit output. Jenkins displays the JUnit file in its test panel, which lets me inspect findings without downloading a report.

### Unit testing and code coverage

The test stage uses `retry(2)`. One flaky network call to MongoDB should not kill an otherwise good build, but a repeat failure still stops it.

I collect coverage with Istanbul and nyc. The stage uses `catchError`, so low coverage marks it as unstable instead of failing the entire build. Jenkins publishes the full lcov report in an HTML panel.

### SAST with SonarQube

After coverage completes, SonarQube scans the source code:

```groovy
withSonarQubeEnv('sonarqube') {
    sh '''
    $SONAR_SCANNER_HOME/bin/sonar-scanner \
        -Dsonar.projectKey=solar-system \
        -Dsonar.sources=app.js \
        -Dsonar.javascript.lcov.reportPaths=./coverage/lcov.info
    '''
}
waitForQualityGate abortPipeline: true
```

The lcov path lets SonarQube identify security-relevant lines without test coverage. `waitForQualityGate abortPipeline: true` waits for the server to finish its analysis and stops the pipeline if the quality gate fails. A failed gate means no image gets built or pushed.

### Container scanning with Trivy

After the Docker build, Trivy runs twice:

```bash
trivy image $DOCKERHUB_USR/solar-system:$GIT_COMMIT \
    --severity LOW,MEDIUM,HIGH \
    --exit-code 0 \
    --quiet \
    --format json -o trivy-image-HIGH-results.json

trivy image $DOCKERHUB_USR/solar-system:$GIT_COMMIT \
    --severity CRITICAL \
    --exit-code 1 \
    --quiet \
    --format json -o trivy-image-CRITICAL-results.json
```

The first pass records findings from LOW through HIGH but returns success because it uses `--exit-code 0`. The second checks only CRITICAL findings and fails the build with `--exit-code 1`. This records lower severity issues without blocking every build on them. At the end, Trivy's template engine converts both JSON files to HTML and JUnit reports.

### DAST with OWASP ZAP

Dynamic testing runs on `PR*` branches after Kubernetes has deployed the application. ZAP reads the OpenAPI specification to find and test each route:

```bash
docker run -v $(pwd):/zap/wrk/:rw -t zaproxy/zap-stable zap.sh \
    -t http://<K8S_NODE_IP>:30000/api-docs/ \
    -f openapi \
    -r zap_report.html \
    -J zap_json_report.json \
    -c zap_ignore_rules.conf
```

The `-f openapi` flag restricts ZAP to documented endpoints instead of asking it to crawl the application. `zap_ignore_rules.conf` filters false positives that do not apply to this API. One example is a missing `X-Frame-Options` header, which matters when serving HTML rather than JSON.

## Deployment paths

### Feature branches to EC2

Feature branches need a short feedback loop. Jenkins connects to the EC2 instance over SSH, stops the existing container when present, and starts the new image:

```bash
ssh -o StrictHostKeyChecking=no ubuntu@<EC2_IP> "
if sudo docker ps -a | grep -q 'solar-system'; then
    sudo docker stop solar-system && sudo docker rm solar-system
fi
sudo docker run --name solar-system \
    -e MONGO_URI=$MONGO_URI \
    -e MONGO_USERNAME=$MONGO_USERNAME \
    -e MONGO_PASSWORD=$MONGO_PASSWORD \
    -e PORT=$PORT \
    -p $PORT:$PORT -d $DOCKERHUB_USR/solar-system:$GIT_COMMIT
"
```

After the container starts, `integration-testing-ec2.sh` calls the live endpoint. A running container is not enough. The application must answer a request.

### PR branches to Kubernetes through GitOps

This path does not deploy directly. The pipeline updates the image tag in a separate GitOps repository and opens a PR there. ArgoCD watches that repository and rolls out the change after the PR merges.

A single `sed` command updates the image tag in the deployment manifest:

```bash
sed -i "s#$DOCKERHUB_USR/solar-system:.*#$DOCKERHUB_USR/solar-system:$GIT_COMMIT#g" deployment.yml
git add .
git commit -am "Updated docker image"
git push -u origin feature-$BUILD_ID
```

The pipeline then opens a PR through the Gitea API. Gitea is the self-hosted Git server in this setup. Once the PR has merged and ArgoCD has synced, the pipeline proceeds to DAST. The order matters because ZAP must test the version that the PR deployed, not the previous one.

The Kubernetes deployment runs two replicas. MongoDB credentials come from a Bitnami Sealed Secret. The repository contains encrypted values, and the Sealed Secrets controller decrypts them inside the cluster:

```yaml
spec:
  replicas: 2
  template:
    spec:
      dnsPolicy: Default
      containers:
        - image: aryanmehesare/solar-system:<GIT_COMMIT>
          ports:
            - containerPort: 8000
          envFrom:
            - secretRef:
                name: mongo-db-creds
```

`dnsPolicy: Default` makes the pod use the node's DNS resolver instead of the cluster's internal resolver. In this setup, pods otherwise cannot resolve the external hostname in the MongoDB connection string.

I can commit the encrypted Sealed Secret to Git without exposing the raw credentials. Only the Sealed Secrets controller in the cluster has the key needed to decrypt it.

### Main branch to Lambda

Production runs on Lambda. The application needs one small change for that environment. Jenkins uses `sed` to remove `app.listen` and export a handler before creating the zip:

```groovy
s3Upload(
    file: "solar-system-lambda-${BUILD_ID}.zip",
    bucket: "solar-system-lambda-bucket"
)
sh """
    aws lambda update-function-code \
    --function-name solar-system-function \
    --s3-bucket solar-system-lambda-bucket \
    --s3-key solar-system-lambda-$BUILD_ID.zip
"""
```

After uploading the zip and updating the function, `update-function-configuration` sets the MongoDB credentials as Lambda environment variables. The pipeline waits 30 seconds, then calls the Function URL with `curl` and expects `200 OK`.

## Report archiving

Every build uploads its reports to S3, regardless of branch:

```groovy
sh '''
    mkdir reports-$BUILD_ID
    cp -rf coverage/ reports-$BUILD_ID/
    cp dependency* test-results.xml trivy*.* zap*.* reports-$BUILD_ID/
'''
withAWS(credentials: 'aws-s3-ec2-lambda-creds', region: 'us-east-2') {
    s3Upload(
        file: "reports-$BUILD_ID",
        bucket: 'solar-system-jenkins-reports-bucket',
        path: "jenkins-$BUILD_ID/"
    )
}
```

Each build retains its OWASP results, Trivy output, ZAP report, and coverage data. If production breaks three months later, I can inspect the scans for the exact commit that was deployed.

## Slack notifications

Every run sends a Slack message when it finishes, pass or fail:

```groovy
def slackNotificationMethod(String buildStatus = 'STARTED') {
    def color = buildStatus == 'SUCCESS' ? '#47ec05' :
                buildStatus == 'UNSTABLE' ? '#d5ee0d' : '#ec2805'
    def msg = "${buildStatus}: *${env.JOB_NAME}* #${env.BUILD_NUMBER}:\n${env.BUILD_URL}"
    slackSend(color: color, message: msg)
}
```

Success messages are green, unstable builds are yellow, and failures are red. Each message includes the build number and a direct link. I do not need to leave a Jenkins tab open while a build runs.

## Infrastructure as code with Terraform

The `terraform/` directory defines the AWS resources in three modules:

```
terraform/
├── main.tf
├── variables.tf
├── outputs.tf
├── terraform.tfvars.example
└── modules/
    ├── ec2/
    ├── s3/
    └── lambda/
```

`modules/ec2` creates the Ubuntu instance used to test feature branches. Its `user_data` installs Docker on first boot, which allows Jenkins to connect over SSH and run containers. The security group allows SSH only from the Jenkins server's IP address.

`modules/s3` creates two private, versioned buckets. One stores build reports and expires them after 90 days. The other stores Lambda deployment archives.

`modules/lambda` creates the function and its IAM role. Its `lifecycle` block deliberately ignores the deployment artifact and environment variables:

```hcl
lifecycle {
    ignore_changes = [s3_key, environment]
}
```

Terraform owns the function runtime, memory, timeout, and IAM configuration. Jenkins owns the deployment artifact and environment variables. Without this separation, each `terraform apply` would undo the latest pipeline deployment.

### Getting it running

Copy the example vars file and fill it in:

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

The variables file needs an EC2 AMI ID for Ubuntu 22.04 LTS in the chosen region, a key pair name, the Jenkins server's IP address, and the MongoDB credentials.

To use remote state, create its S3 bucket first:

```bash
aws s3api create-bucket \
    --bucket solar-system-tf-state \
    --region ap-south-1 \
    --create-bucket-configuration LocationConstraint=ap-south-1
```

Then initialize and apply the configuration:

```bash
terraform init
terraform plan
terraform apply
```

After `terraform apply` finishes, its outputs include the EC2 IP address and Lambda Function URL. Add both values to the `Jenkinsfile` before the first pipeline run.

## Things that caught me out

OWASP Dependency-Check is slow on a fresh agent. The first NVD database download takes more than 10 minutes. Caching its database directory between runs cuts later scans to seconds.

Kubernetes pods needed `dnsPolicy: Default`. The cluster's `ClusterFirst` setting routes lookups through its internal resolver, which could not resolve my external MongoDB hostname. Switching to `Default` uses the node's resolver. This took me far too long to trace.

Trivy exits with code 0 unless told otherwise. Without `--exit-code 1` on the critical scan, it can find critical vulnerabilities and still report success. Some supposedly clean Trivy builds are only ignoring the exit code.

ZAP's traditional crawler is useless for this REST API because it looks for HTML links. The `-f openapi` option points it at the OpenAPI specification, so it discovers and tests the documented endpoints instead.

Sealed Secrets do not rotate themselves. To update a MongoDB password, I seal the new value locally with the cluster's public key and commit the new encrypted file. The controller then applies it. Losing the key would make the existing files impossible to decrypt.

## Tool reference

| Tool                       | What it does in this pipeline                                  |
| -------------------------- | -------------------------------------------------------------- |
| Jenkins                    | Runs the pipeline, manages credentials, publishes reports      |
| Docker / DockerHub         | Builds and stores the app image, tagged by commit SHA          |
| SonarQube                  | Static code analysis with a quality gate that blocks the build |
| OWASP Dependency-Check     | Scans npm packages against the NIST CVE database               |
| Trivy                      | Scans the Docker image for OS and package vulnerabilities      |
| OWASP ZAP                  | Dynamic testing against the live running app                   |
| Kubernetes                 | Runs the app in production with 2 replicas on NodePort 30000   |
| ArgoCD                     | Watches the GitOps repo and syncs the cluster on PR merge      |
| Gitea                      | Self-hosted Git server that hosts the GitOps manifest repo     |
| Bitnami Sealed Secrets     | Encrypts Kubernetes secrets for storage in Git                 |
| AWS EC2                    | Staging environment for feature branches                       |
| AWS Lambda                 | Production environment for the main branch                     |
| AWS S3                     | Stores build reports and Lambda deployment zips                |
| Terraform                  | Provisions all AWS infrastructure from code                    |
| Slack                      | Sends each build result and link                                |

## What I would build first

The full source includes the application, `Jenkinsfile`, Kubernetes manifests, and Terraform modules. It is available at [github.com/mortal22soul/e2e-cicd-pipeline](https://github.com/mortal22soul/e2e-cicd-pipeline).

If I were setting this up again, I would add one stage at a time. I would get the unit tests and Docker build passing first, then add SonarQube and Trivy. OWASP Dependency-Check and ZAP would come last. Every scanner produces some noise, and tuning one is much easier before another starts adding findings.
