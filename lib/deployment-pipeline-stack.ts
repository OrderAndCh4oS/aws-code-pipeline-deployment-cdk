import {SecretValue, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from "constructs";
import {BuildEnvironmentVariableType, BuildSpec, LinuxBuildImage, PipelineProject} from "aws-cdk-lib/aws-codebuild";
import {
    CloudFormationCreateUpdateStackAction,
    CodeBuildAction,
    GitHubSourceAction
} from "aws-cdk-lib/aws-codepipeline-actions";
import {Artifact, Pipeline} from "aws-cdk-lib/aws-codepipeline";
import {Effect, PolicyStatement, Role} from "aws-cdk-lib/aws-iam";

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

        // Create the IAM policy statement for ECR access
        const ecrPolicyStatement = new PolicyStatement({
            effect: Effect.ALLOW,
            actions: [
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:GetRepositoryPolicy',
                'ecr:DescribeRepositories',
                'ecr:ListImages',
                'ecr:DescribeImages',
                'ecr:BatchGetImage',
                'ecr:GetLifecyclePolicy',
                'ecr:GetLifecyclePolicyPreview',
                'ecr:GetRepositoryPolicy',
                'ecr:ListTagsForResource',
                'ecr:PutLifecyclePolicy',
                'ecr:SetRepositoryPolicy',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
            ],
            resources: ['*'], // You can specify specific ECR repositories if needed
        });

        const buildProject = new PipelineProject(this, 'ApiBuildProject', {
            buildSpec: BuildSpec.fromObject({
                version: '0.2',
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
                            'AWS_ECR_LOGIN=$(aws ecr get-login-password --region eu-west-1)',
                            'echo $AWS_ECR_LOGIN', // This will print the authentication token
                            '$AWS_ECR_LOGIN | docker login --username AWS --password-stdin 914698808609.dkr.ecr.eu-west-1.amazonaws.com/api-pipeline-images',
                        ],
                    },
                    build: {
                        commands: [
                            'npm run build', // Or any other command to build your CDK app
                            'npx cdk synth', // Generate the CloudFormation template
                            'docker build -t 914698808609.dkr.ecr.eu-west-1.amazonaws.com/api-pipeline-images:latest ./src', // Build Docker image
                            'docker push 914698808609.dkr.ecr.eu-west-1.amazonaws.com/api-pipeline-images:latest', // Push Docker image to ECR
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
                privileged: true
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

        const buildProjectRole = buildProject.role as Role;
        buildProjectRole.addToPolicy(ecrPolicyStatement);

        const pipelineRole = pipeline.role as Role;
        pipelineRole.addToPolicy(secretAccessPolicyStatement);
    }
}
