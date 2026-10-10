terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {}
}

provider "aws" {
  region = var.aws_region
}

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

data "aws_sqs_queue" "api" {
  for_each = toset([
    "inventory-broker-shop-catalog.fifo",
    "inventory-broker-shop-work-orders.fifo",
    "inventory-broker-shop-inspections.fifo",
    "inventory-broker-shop-purchasing.fifo",
    "inventory-broker-notifications.fifo",
    "inventory-broker-inventory-events.fifo",
    "inventory-broker-inventory-dlq.fifo",
  ])

  name = each.value
}

locals {
  name = "hack-saltillo-api"

  container_environment = [
    { name = "NODE_ENV", value = "dev" },
    { name = "PORT", value = "8000" },
    { name = "CORS_ORIGIN", value = var.cors_origin },
    { name = "DATABASE_HOST", value = var.database_host },
    { name = "DATABASE_PORT", value = tostring(var.database_port) },
    { name = "DATABASE_NAME", value = var.database_name },
    { name = "DATABASE_USER", value = var.database_user },
    { name = "DATABASE_SSL", value = "true" },
    { name = "AWS_REGION", value = var.aws_region },
    { name = "AGENT_URL", value = var.agent_url },
    { name = "SQS_SHOP_CATALOG_URL", value = data.aws_sqs_queue.api["inventory-broker-shop-catalog.fifo"].url },
    { name = "SQS_SHOP_WORK_ORDERS_URL", value = data.aws_sqs_queue.api["inventory-broker-shop-work-orders.fifo"].url },
    { name = "SQS_SHOP_INSPECTIONS_URL", value = data.aws_sqs_queue.api["inventory-broker-shop-inspections.fifo"].url },
    { name = "SQS_SHOP_PURCHASING_URL", value = data.aws_sqs_queue.api["inventory-broker-shop-purchasing.fifo"].url },
    { name = "SQS_NOTIFICATIONS_URL", value = data.aws_sqs_queue.api["inventory-broker-notifications.fifo"].url },
    { name = "SQS_INVENTORY_EVENTS_URL", value = data.aws_sqs_queue.api["inventory-broker-inventory-events.fifo"].url },
    { name = "SQS_INVENTORY_DLQ_URL", value = data.aws_sqs_queue.api["inventory-broker-inventory-dlq.fifo"].url },
  ]
}

resource "aws_ecr_repository" "api" {
  name                 = local.name
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}"
  retention_in_days = 30
}

resource "aws_iam_role" "execution" {
  name = "${local.name}-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secret" {
  name = "read-database-password"
  role = aws_iam_role.execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = var.database_password_secret_arn
    }]
  })
}

resource "aws_iam_role" "task" {
  name = "${local.name}-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy" "task_sqs" {
  name = "access-inventory-queues"
  role = aws_iam_role.task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        "sqs:SendMessage",
      ]
      Resource = [for queue in data.aws_sqs_queue.api : queue.arn]
    }]
  })
}

resource "aws_security_group" "load_balancer" {
  name        = "${local.name}-alb"
  description = "Public HTTP access to the API load balancer"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "task" {
  name        = "${local.name}-task"
  description = "API tasks accept traffic only from the load balancer"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    from_port       = 8000
    to_port         = 8000
    protocol        = "tcp"
    security_groups = [aws_security_group.load_balancer.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_vpc_security_group_ingress_rule" "database_from_api" {
  security_group_id            = var.database_security_group_id
  referenced_security_group_id = aws_security_group.task.id
  description                  = "PostgreSQL from ${local.name} ECS tasks"
  from_port                    = var.database_port
  to_port                      = var.database_port
  ip_protocol                  = "tcp"
}

resource "aws_lb" "api" {
  name               = "hack-saltillo-api"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.load_balancer.id]
  subnets            = data.aws_subnets.default.ids
}

resource "aws_lb_target_group" "api" {
  name        = "hack-saltillo-api"
  port        = 8000
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = data.aws_vpc.default.id

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_cluster" "api" {
  name = local.name
}

resource "aws_ecs_task_definition" "api" {
  family                   = local.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = local.name
    image     = "${aws_ecr_repository.api.repository_url}:${var.image_tag}"
    essential = true
    portMappings = [{
      containerPort = 8000
      hostPort      = 8000
      protocol      = "tcp"
    }]
    environment = local.container_environment
    secrets = [{
      name      = "DATABASE_PASSWORD"
      valueFrom = var.database_password_secret_arn
    }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])

  depends_on = [aws_iam_role_policy_attachment.execution, aws_iam_role_policy.execution_secret]
}

resource "aws_ecs_service" "api" {
  name            = local.name
  cluster         = aws_ecs_cluster.api.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = local.name
    container_port   = 8000
  }

  depends_on = [aws_lb_listener.http, aws_vpc_security_group_ingress_rule.database_from_api]
}
