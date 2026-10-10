#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'Uso: AWS_REGION=us-east-1 %s OWNER/REPO\n' "$0" >&2
  exit 2
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Falta el comando requerido: %s\n' "$1" >&2
    exit 1
  }
}

prompt_value() {
  local label="$1"
  local default_value="${2:-}"
  local answer
  if [[ -n "$default_value" ]]; then
    read -r -p "$label [$default_value]: " answer
    printf '%s' "${answer:-$default_value}"
  else
    read -r -p "$label: " answer
    printf '%s' "$answer"
  fi
}

require_command aws
require_command gh
require_command jq

aws sts get-caller-identity >/dev/null
gh auth status >/dev/null

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
[[ "$repo" == */* ]] || usage
repo_owner="${repo%%/*}"
repo_name="${repo#*/}"
repo_ids="$(gh api "repos/$repo" --jq '{owner_id: .owner.id, repo_id: .id}')"
owner_id="$(jq -r '.owner_id' <<<"$repo_ids")"
repo_id="$(jq -r '.repo_id' <<<"$repo_ids")"

region="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
account_id="$(aws sts get-caller-identity --query Account --output text)"
partition="$(aws sts get-caller-identity --query Arn --output text | cut -d: -f2)"
role_name="github-actions-hack-saltillo-api"
role_arn="arn:${partition}:iam::${account_id}:role/${role_name}"
bucket="${TF_STATE_BUCKET:-hack-saltillo-api-tfstate-${account_id}-${region}}"

printf '\nRepo GitHub: %s\nAWS account: %s\nRegión: %s\n' "$repo" "$account_id" "$region"
printf 'Se crearán un bucket S3 (%s), un proveedor OIDC si no existe y el role %s.\n\n' "$bucket" "$role_name"
read -r -p 'Continuar? [y/N] ' confirm
[[ "$confirm" == [yY] || "$confirm" == [yY][eE][sS] ]] || exit 1

provider_arn="arn:${partition}:iam::${account_id}:oidc-provider/token.actions.githubusercontent.com"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
fi
client_ids="$(aws iam get-open-id-connect-provider \
  --open-id-connect-provider-arn "$provider_arn" \
  --query ClientIDList --output json)"
if ! jq -e 'index("sts.amazonaws.com") != null' <<<"$client_ids" >/dev/null; then
  aws iam add-client-id-to-open-id-connect-provider \
    --open-id-connect-provider-arn "$provider_arn" \
    --client-id sts.amazonaws.com
fi

branch_subject="repo:${repo_owner}@${owner_id}/${repo_name}@${repo_id}:ref:refs/heads/*"
trust_policy="$(jq -n --arg provider_arn "$provider_arn" --arg subject "$branch_subject" '{
  Version: "2012-10-17",
  Statement: [{
    Effect: "Allow",
    Principal: { Federated: $provider_arn },
    Action: "sts:AssumeRoleWithWebIdentity",
    Condition: {
      StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      StringLike: { "token.actions.githubusercontent.com:sub": $subject }
    }
  }]
}')"

if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$role_name" --policy-document "$trust_policy"
else
  aws iam create-role \
    --role-name "$role_name" \
    --description "GitHub Actions deploy role for ${repo}" \
    --assume-role-policy-document "$trust_policy" >/dev/null
fi

policy="$(jq -n --arg partition "$partition" --arg account "$account_id" --arg region "$region" --arg bucket "$bucket" '{
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "TerraformState",
      Effect: "Allow",
      Action: ["s3:GetBucketLocation", "s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      Resource: ["arn:" + $partition + ":s3:::" + $bucket, "arn:" + $partition + ":s3:::" + $bucket + "/*"]
    },
    {
      Sid: "ECR",
      Effect: "Allow",
      Action: ["ecr:GetAuthorizationToken"],
      Resource: "*"
    },
    {
      Sid: "ECRRepository",
      Effect: "Allow",
      Action: ["ecr:CreateRepository", "ecr:DeleteRepository", "ecr:DescribeRepositories", "ecr:ListTagsForResource", "ecr:PutImageTagMutability", "ecr:PutImageScanningConfiguration", "ecr:TagResource", "ecr:UntagResource", "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage"],
      Resource: ("arn:" + $partition + ":ecr:" + $region + ":" + $account + ":repository/hack-saltillo-api")
    },
    {
      Sid: "ECSAndLoadBalancing",
      Effect: "Allow",
      Action: ["ecs:CreateCluster", "ecs:DeleteCluster", "ecs:Describe*", "ecs:List*", "ecs:CreateService", "ecs:UpdateService", "ecs:DeleteService", "ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition", "ecs:TagResource", "ecs:UntagResource", "elasticloadbalancing:*", "logs:CreateLogGroup", "logs:DeleteLogGroup", "logs:Describe*", "logs:ListTagsForResource", "logs:PutRetentionPolicy", "logs:DeleteRetentionPolicy", "logs:TagResource", "logs:UntagResource"],
      Resource: "*"
    },
    {
      Sid: "NetworkingAndQueues",
      Effect: "Allow",
      Action: ["ec2:DescribeVpcs", "ec2:DescribeVpcAttribute", "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups", "ec2:DescribeSecurityGroupRules", "ec2:DescribeNetworkInterfaces", "ec2:DescribeAvailabilityZones", "ec2:DescribeInternetGateways", "ec2:DescribeAccountAttributes", "ec2:DescribeTags", "ec2:CreateSecurityGroup", "ec2:DeleteSecurityGroup", "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress", "ec2:AuthorizeSecurityGroupEgress", "ec2:RevokeSecurityGroupEgress", "ec2:CreateTags", "ec2:DeleteTags"],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: ["sqs:GetQueueUrl", "sqs:GetQueueAttributes", "sqs:ListQueueTags"],
      Resource: ("arn:" + $partition + ":sqs:" + $region + ":" + $account + ":inventory-broker-*")
    },
    {
      Sid: "ManageTaskRoles",
      Effect: "Allow",
      Action: ["iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies", "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole"],
      Resource: ("arn:" + $partition + ":iam::" + $account + ":role/hack-saltillo-api-*")
    },
    {
      Effect: "Allow",
      Action: ["iam:ListRoles"],
      Resource: "*"
    },
    {
      Effect: "Allow",
      Action: ["iam:GetPolicy", "iam:GetPolicyVersion"],
      Resource: ("arn:" + $partition + ":iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy")
    },
    {
      Effect: "Allow",
      Action: ["iam:PassRole"],
      Resource: ("arn:" + $partition + ":iam::" + $account + ":role/hack-saltillo-api-*"),
      Condition: { StringEquals: { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    },
    {
      Effect: "Allow",
      Action: ["iam:CreateServiceLinkedRole"],
      Resource: [
        ("arn:" + $partition + ":iam::*:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS"),
        ("arn:" + $partition + ":iam::*:role/aws-service-role/elasticloadbalancing.amazonaws.com/AWSServiceRoleForElasticLoadBalancing")
      ],
      Condition: { StringLike: { "iam:AWSServiceName": ["ecs.amazonaws.com", "elasticloadbalancing.amazonaws.com"] } }
    }
  ]
}')"
aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name hack-saltillo-api-deploy \
  --policy-document "$policy"

if ! aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
  if [[ "$region" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$bucket" --region "$region" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "$bucket" \
      --region "$region" \
      --create-bucket-configuration "LocationConstraint=$region" >/dev/null
  fi
else
  printf 'Reutilizando bucket S3 existente: %s\n' "$bucket"
fi
aws s3api put-bucket-versioning --bucket "$bucket" --versioning-configuration Status=Enabled
aws s3api put-public-access-block \
  --bucket "$bucket" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-encryption \
  --bucket "$bucket" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

cors_origin="$(prompt_value 'CORS_ORIGIN (origen de la UI)' '')"
database_host="$(prompt_value 'DATABASE_HOST (endpoint RDS)' '')"
database_port="$(prompt_value 'DATABASE_PORT' '5432')"
database_name="$(prompt_value 'DATABASE_NAME' 'inventario')"
database_user="$(prompt_value 'DATABASE_USER' 'inventario')"
database_security_group_id="$(prompt_value 'DATABASE_SECURITY_GROUP_ID (sg-...)' '')"
agent_url="$(prompt_value 'AGENT_URL (opcional)' '')"
database_secret_arn="$(prompt_value 'DATABASE_PASSWORD_SECRET_ARN existente (Enter para crear secreto)' '')"

if [[ -z "$database_secret_arn" ]]; then
  read -r -s -p 'Contraseña PostgreSQL (no se mostrará): ' database_password
  printf '\n'
  [[ -n "$database_password" ]] || { printf 'La contraseña no puede estar vacía.\n' >&2; exit 1; }
  database_secret_arn="$(aws secretsmanager create-secret \
    --name hack-saltillo-api/database-password \
    --description 'Password de PostgreSQL para hack-saltillo-api' \
    --secret-string "$database_password" \
    --query ARN --output text)"
  unset database_password
fi

required_values=(
  "CORS_ORIGIN=$cors_origin"
  "DATABASE_HOST=$database_host"
  "DATABASE_SECURITY_GROUP_ID=$database_security_group_id"
  "DATABASE_PASSWORD_SECRET_ARN=$database_secret_arn"
)
for entry in "${required_values[@]}"; do
  [[ "${entry#*=}" != "" ]] || { printf 'Falta el valor requerido: %s\n' "${entry%%=*}" >&2; exit 1; }
done

variables=(
  "AWS_ROLE_ARN=$role_arn"
  "AWS_REGION=$region"
  "TF_STATE_BUCKET=$bucket"
  "CORS_ORIGIN=$cors_origin"
  "DATABASE_HOST=$database_host"
  "DATABASE_PORT=$database_port"
  "DATABASE_NAME=$database_name"
  "DATABASE_USER=$database_user"
  "DATABASE_PASSWORD_SECRET_ARN=$database_secret_arn"
  "DATABASE_SECURITY_GROUP_ID=$database_security_group_id"
  "AGENT_URL=$agent_url"
)
for entry in "${variables[@]}"; do
  variable_name="${entry%%=*}"
  variable_value="${entry#*=}"
  if [[ "$variable_name" == "AGENT_URL" && -z "$variable_value" ]]; then
    gh variable delete "$variable_name" --repo "$repo" >/dev/null 2>&1 || true
  else
    gh variable set "$variable_name" --repo "$repo" --body "$variable_value"
  fi
done

printf '\nVariables guardadas en GitHub para %s:\n' "$repo"
printf '  AWS_ROLE_ARN=%s\n' "$role_arn"
printf '  AWS_REGION=%s\n' "$region"
printf '  TF_STATE_BUCKET=%s\n' "$bucket"
printf '  CORS_ORIGIN=%s\n' "$cors_origin"
printf '  DATABASE_HOST=%s\n' "$database_host"
printf '  DATABASE_PORT=%s\n' "$database_port"
printf '  DATABASE_NAME=%s\n' "$database_name"
printf '  DATABASE_USER=%s\n' "$database_user"
printf '  DATABASE_PASSWORD_SECRET_ARN=%s\n' "$database_secret_arn"
printf '  DATABASE_SECURITY_GROUP_ID=%s\n' "$database_security_group_id"
printf '  AGENT_URL=%s\n' "$agent_url"
printf '\nListo. Ejecuta un push a cualquier rama o dispara Deploy API desde Actions.\n'
