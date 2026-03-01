---
title: "Building an End to End DevSecOps CI/CD Pipeline"
description: "How I built a CI/CD pipeline for a Node.js app with Jenkins, Docker, Kubernetes, ArgoCD, Sealed Secrets, SonarQube, Trivy, OWASP ZAP, and AWS infrastructure on Terraform."
date: "Sep 18 2025"
demoURL: ""
repoURL: "https://github.com/mortal22soul/e2e-cicd-pipeline"
---

# Building an End-to-End DevSecOps CI/CD Pipeline

The honest reason I built this: I got tired of pipelines that were just a fancy way of running `npm install && docker push`. They tell you the build passed but say nothing about whether the image you just shipped has a known CVE, or whether your dependencies have been piling up vulnerabilities for months.

So I built one that treats security as part of the process, not an add-on. The app itself is a small Node.js API about planets. The pipeline around it is what this post is really about.

## The App

The Solar System API is a Node.js/Express app backed by MongoDB. It has a `/live` endpoint for health checks and a `/planet` endpoint that returns planet data. That's it. Simple enough that you can focus on what the pipeline does to it rather than what the app does.

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

Alpine base, lightweight image. The placeholder env vars show what the container needs — the real values come from Jenkins at runtime and never get written into the image. This matters because anything baked into an image layer can be pulled out with `docker history`, even if you change it later.

## Pipeline Structure

The pipeline is a Jenkins declarative pipeline, defined in `Jenkinsfile`. There are three paths depending on which branch triggered the build:

| Branch      | What happens                                              |
| ----------- | --------------------------------------------------------- |
| `feature/*` | Build → scan → deploy to EC2 → integration test           |
| `PR*`       | Build → scan → update GitOps repo → DAST → upload reports |
| `main`      | Build → scan → deploy to Lambda → smoke test              |

A couple of global settings that are worth pointing out:

```groovy
options {
    timeout(time: 1, unit: 'HOURS')
    disableResume()
    disableConcurrentBuilds abortPrevious: true
}
```

`disableConcurrentBuilds abortPrevious: true` is the one that saves the most headaches. If you push twice on the same branch back to back, Jenkins cancels the first run instead of running both at once. On a self-hosted Jenkins with limited memory, this matters a lot.

## Security Scanning

Most pipelines that call themselves "DevSecOps" have one SAST scan somewhere and leave it at that. This one runs five checks across three different points: your dependencies, your source code, and the built image.

### Dependency Scanning (Parallel)

Two scans run in parallel right after `npm install`:

**npm audit** with `--audit-level=critical` — a quick check for known bad packages. It logs the result but doesn't fail the stage because the next scan is the real gate.

**OWASP Dependency-Check** checks every package against the NIST vulnerability database. The first time it runs, it downloads the full database so it can be slow. After that it's much faster. Here's the config:

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

If it finds more than four critical issues, the build stops. `--format "ALL"` outputs HTML, JSON, XML, and JUnit at the same time — the JUnit file shows up in Jenkins' test panel inline so you don't have to download a separate file to see what's flagged.

### Unit Testing and Code Coverage

Tests run with `retry(2)` on the stage so one flaky network call to MongoDB doesn't kill an otherwise good build.

Code coverage uses Istanbul/nyc. The stage uses `catchError` so that low coverage marks the stage yellow (unstable) rather than failing the whole build outright. The full lcov report gets published as an HTML panel in Jenkins.

### SAST — SonarQube

After coverage runs, SonarQube scans the source code:

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

Passing the lcov path lets SonarQube flag security-relevant lines that also have no tests. `waitForQualityGate abortPipeline: true` waits for the server to finish the scan and then kills the pipeline if the quality gate fails. Nothing gets built or pushed if the code doesn't pass.

### Container Scanning — Trivy

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

The first pass records LOW through HIGH but doesn't fail the build (`--exit-code 0`). The second pass checks CRITICAL only and does fail the build (`--exit-code 1`). You get full visibility in the reports without blocking on every medium-risk finding. Both JSON files get converted to HTML and JUnit at the end using Trivy's template engine.

### DAST — OWASP ZAP

Dynamic testing runs on `PR*` branches after the app is live on Kubernetes. ZAP targets the OpenAPI spec to find and test every route:

```bash
docker run -v $(pwd):/zap/wrk/:rw -t zaproxy/zap-stable zap.sh \
    -t http://<K8S_NODE_IP>:30000/api-docs/ \
    -f openapi \
    -r zap_report.html \
    -J zap_json_report.json \
    -c zap_ignore_rules.conf
```

The `-f openapi` flag makes ZAP test only the documented endpoints rather than trying to crawl. `zap_ignore_rules.conf` filters out false positives for things that don't apply to an API — like missing `X-Frame-Options`, which only matters if you're serving HTML.

## Deployment Paths

### Feature Branches → EC2

Fast loop for testing in-progress work. Jenkins SSHs into the EC2 instance, stops the old container if one is running, and starts a new one:

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

After the container starts, `integration-testing-ec2.sh` hits the live endpoint to check the app actually works — not just that the container came up.

### PR Branches → Kubernetes via GitOps

This path doesn't deploy directly. Instead the pipeline updates the image tag in a separate GitOps repo and raises a PR there. ArgoCD watches that repo and rolls out the change when the PR is merged.

The image tag update is a one-liner `sed` in the deployment manifest:

```bash
sed -i "s#$DOCKERHUB_USR/solar-system:.*#$DOCKERHUB_USR/solar-system:$GIT_COMMIT#g" deployment.yml
git add .
git commit -am "Updated docker image"
git push -u origin feature-$BUILD_ID
```

Then a PR is raised via the **Gitea** API (the self-hosted Git server). Once you confirm the PR is merged and ArgoCD has synced, the pipeline moves on to DAST. Keeping that order matters — ZAP tests what's actually running, not what was running before.

The Kubernetes deployment runs two replicas. MongoDB credentials come from a **Bitnami Sealed Secret** — encrypted at rest in the repo, decrypted inside the cluster by the Sealed Secrets controller:

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

`dnsPolicy: Default` tells the pod to use the node's DNS resolver instead of the cluster's internal one. Without it, pods can't reach external hostnames like a MongoDB connection string pointing outside the cluster.

Sealed Secrets means you can commit the encrypted secret file to Git safely. The raw credentials never appear in the repo. The Sealed Secrets controller running in the cluster is the only thing that can decrypt it.

### Main Branch → Lambda

Production runs serverless. The app needs a small change to work as a Lambda function — `app.listen` gets removed and a handler gets exported. Jenkins does this with `sed` inline before zipping everything up:

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

After uploading the zip and updating the function, `update-function-configuration` sets the MongoDB credentials as Lambda environment variables. A `curl` against the Function URL after 30 seconds confirms the function is responding with `200 OK`.

## Report Archiving

Every build uploads all its reports to S3, regardless of branch:

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

OWASP results, Trivy outputs, ZAP report, coverage — all of it, per build. If something breaks in production three months from now and you need to check what the scans looked like on a specific commit, it's there.

## Notifications — Slack

Every run sends a Slack message when it finishes, pass or fail:

```groovy
def slackNotificationMethod(String buildStatus = 'STARTED') {
    def color = buildStatus == 'SUCCESS' ? '#47ec05' :
                buildStatus == 'UNSTABLE' ? '#d5ee0d' : '#ec2805'
    def msg = "${buildStatus}: *${env.JOB_NAME}* #${env.BUILD_NUMBER}:\n${env.BUILD_URL}"
    slackSend(color: color, message: msg)
}
```

Green for success, yellow for unstable, red for failure. The message has the build number and a direct link. Nobody has to keep a Jenkins tab open to know what's happening.

## Infrastructure as Code — Terraform

All the AWS bits the pipeline needs are defined in `terraform/`, split into three modules:

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

**`modules/ec2`** creates the Ubuntu instance used for feature-branch testing. Docker is installed on first boot via `user_data` so Jenkins can SSH in and run containers straight away. SSH access is locked to your Jenkins server's IP only.

**`modules/s3`** creates two private buckets — one for build reports (with a 90-day expiry so old reports clean themselves up) and one for Lambda deployment zips. Both are fully private with versioning on.

**`modules/lambda`** creates the function and its IAM role. There's a `lifecycle` block that intentionally ignores the deployment artifact and env vars:

```hcl
lifecycle {
    ignore_changes = [s3_key, environment]
}
```

Terraform owns the function's config — runtime, memory, timeout, IAM. Jenkins owns the deployment artifact and environment variables. Without this, every `terraform apply` would undo whatever the last pipeline run deployed.

### Getting It Running

Copy the example vars file and fill it in:

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
```

You'll need an EC2 AMI ID (Ubuntu 22.04 LTS in your region), a key pair name, your Jenkins server's IP, and your MongoDB credentials.

Create the S3 bucket for remote state first if you want it:

```bash
aws s3api create-bucket \
    --bucket solar-system-tf-state \
    --region ap-south-1 \
    --create-bucket-configuration LocationConstraint=ap-south-1
```

Then run the usual:

```bash
terraform init
terraform plan
terraform apply
```

After apply finishes, the outputs give you the EC2 IP and Lambda Function URL. Put both into the `Jenkinsfile` before your first pipeline run.

## Things That Caught Me Out

**OWASP Dependency-Check is slow on a fresh agent.** The NVD database download takes 10+ minutes the first time. Caching the database directory between runs cuts that down to seconds.

**`dnsPolicy: Default` on Kubernetes pods.** The cluster's default DNS setting (`ClusterFirst`) routes everything through the internal resolver, which has no idea what an external MongoDB hostname is. Switching to `Default` uses the node's resolver. Took too long to figure that one out.

**Trivy exits 0 unless you say otherwise.** If you don't set `--exit-code 1` on the critical scan, Trivy will find critical vulnerabilities and still report success. A lot of setups that say "Trivy is clean" are actually just not checking the exit code.

**ZAP's crawler is useless on REST APIs.** The traditional ZAP spider crawls HTML links. Use `-f openapi` to point it at your OpenAPI spec instead — it discovers and tests exactly the documented endpoints.

**Sealed Secrets are not auto-rotated.** If you need to update a MongoDB password, you re-seal the secret locally with the cluster's public key and commit the new encrypted file. The controller picks it up. Just don't lose the key.

## Tools Used — Quick Reference

| Tool                       | What it does in this pipeline                                  |
| -------------------------- | -------------------------------------------------------------- |
| **Jenkins**                | Runs the pipeline, manages credentials, publishes reports      |
| **Docker / DockerHub**     | Builds and stores the app image, tagged by commit SHA          |
| **SonarQube**              | Static code analysis with a quality gate that blocks the build |
| **OWASP Dependency-Check** | Scans npm packages against the NIST CVE database               |
| **Trivy**                  | Scans the Docker image for OS and package vulnerabilities      |
| **OWASP ZAP**              | Dynamic testing against the live running app                   |
| **Kubernetes**             | Runs the app in production (2 replicas, NodePort on 30000)     |
| **ArgoCD**                 | Watches the GitOps repo and syncs the cluster on PR merge      |
| **Gitea**                  | Self-hosted Git server, hosts the GitOps manifest repo         |
| **Bitnami Sealed Secrets** | Encrypts Kubernetes secrets so they can be committed to Git    |
| **AWS EC2**                | Staging environment for feature branches                       |
| **AWS Lambda**             | Production environment for the main branch                     |
| **AWS S3**                 | Stores build reports and Lambda deployment zips                |
| **Terraform**              | Provisions all AWS infrastructure from code                    |
| **Slack**                  | Gets a message on every build with pass/fail and a link        |

## Wrapping Up

The full source — app, Jenkinsfile, Kubernetes manifests, and Terraform modules — is at [github.com/mortal22soul/e2e-cicd-pipeline](https://github.com/mortal22soul/e2e-cicd-pipeline).

If you're setting this up yourself: add the stages one at a time. Get unit tests and the Docker build clean first. Then SonarQube. Then Trivy. OWASP and ZAP last. Each tool adds some noise you need to tune out before the next one makes sense.
