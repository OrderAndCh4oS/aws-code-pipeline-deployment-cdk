import {SecretValue, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from "constructs";
import {BuildEnvironmentVariableType, BuildSpec, LinuxBuildImage, PipelineProject} from "aws-cdk-lib/aws-codebuild";
import {
    CloudFormationCreateUpdateStackAction,
    CodeBuildAction,
    GitHubSourceAction
} from "aws-cdk-lib/aws-codepipeline-actions";
import {Artifact, Pipeline} from "aws-cdk-lib/aws-codepipeline";
import {PolicyStatement, Role} from "aws-cdk-lib/aws-iam";

export class DeploymentPipelineStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        // Todo: Use params and possibly envs
        const repositoryOwner = 'OrderAndCh4oS';
        const repositoryName = 'python-api-template-ecs-fargate-cdk';
        const branchName = 'main';

        // Create the IAM policy statement
        const secretAccessPolicyStatement = new PolicyStatement({
            actions: ['secretsmanager:GetSecretValue'],
            resources: [
                'arn:aws:secretsmanager:eu-west-1:914698808609:secret:GitHubAccessToken-FELixh',
            ],
        });

        const buildProject = new PipelineProject(this, 'ApiBuildProject', {
            buildSpec: BuildSpec.fromObject({
                version: '0.2',
                env: {
                    'variables': {
                        'DOCKER_REPO': { value: '914698808609.dkr.ecr.eu-west-1.amazonaws.com/api-pipeline-images' },
                    }
                },
                phases: {
                    install: {
                        commands: [
                            'npm install -g aws-cdk',
                            'npm install',
                        ],
                    },
                    pre_build: {
                        commands: [
                            'echo Logging in to Amazon ECR...',
                            'aws ecr get-login-password --region eu-west-1 | docker login --username AWS --password-stdin 914698808609.dkr.ecr.eu-west-1.amazonaws.com/api-pipeline-images',
                        ],
                    },
                    build: {
                        commands: [
                            'npm run build', // Or any other command to build your CDK app
                            'npx cdk synth', // Generate the CloudFormation template
                            'docker build -t $DOCKER_REPO ./src', // Build Docker image
                            'docker push $DOCKER_REPO', // Push Docker image to ECR
                        ],
                    },
                },
                artifacts: {
                    'base-directory': 'cdk.out',
                    files: ['DeploymentApiStack.template.json'], // Replace with the generated CloudFormation template name
                },
            }),
            environment: {
                buildImage: LinuxBuildImage.STANDARD_7_0, // Use a Docker-enabled CodeBuild environment
            },
        });



        const pipeline = new Pipeline(this, 'ApiPipeline', {
            pipelineName: 'ApiDeploymentPipeline',
            crossAccountKeys: false,
        });

        // Add source stage (GitHub)
        const sourceStage = pipeline.addStage({ stageName: 'Source' });
        const githubSourceOutput = new Artifact('GitHubSourceOutput'); // Create the GitHubSourceOutput artifact

        sourceStage.addAction(
            new GitHubSourceAction({
                actionName: 'GitHubSource',
                owner: repositoryOwner,
                repo: repositoryName,
                branch: branchName,
                oauthToken: SecretValue.secretsManager('GitHubAccessToken'),
                output: githubSourceOutput, // Use the GitHubSourceOutput artifact as output
            })
        );

        // Add build stage (CodeBuild)
        const buildStage = pipeline.addStage({ stageName: 'Build' });
        buildStage.addAction(
            new CodeBuildAction({
                actionName: 'CodeBuild',
                project: buildProject,
                input: githubSourceOutput, // Use the GitHubSourceOutput artifact as input
                outputs: [new Artifact('BuildOutput')], // Define an artifact to store the build output
                environmentVariables: { // Pass the ECR repository URI as an environment variable
                    'ECR_REPOSITORY_URI': {
                        type: BuildEnvironmentVariableType.PLAINTEXT,
                        value: '914698808609.dkr.ecr.eu-west-1.amazonaws.com/api-pipeline-images',
                    },
                },
            })
        );

        // Add deploy stage (CDK)
        const deployStage = pipeline.addStage({ stageName: 'Deploy' });
        deployStage.addAction(
            new CloudFormationCreateUpdateStackAction({
                actionName: 'CFN_Deploy',
                stackName: 'ApiStack',
                templatePath: new Artifact('BuildOutput').atPath('DeploymentApiStack.template.json'), // Use the output from the previous build stage
                adminPermissions: true, // Use this only for testing; otherwise, define the appropriate IAM permissions
                parameterOverrides: {
                    // Define any parameter overrides if required
                },
            })
        );

        // Attach the IAM policy to the pipeline role
        const pipelineRole = pipeline.role as Role; // Cast the pipeline.role to Role
        pipelineRole.addToPolicy(secretAccessPolicyStatement);

    }
}
