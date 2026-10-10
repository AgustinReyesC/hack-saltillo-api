output "api_url" {
  description = "Public HTTP URL for the API and its WebSocket endpoint."
  value       = "http://${aws_lb.api.dns_name}"
}

output "ecr_repository_url" {
  description = "ECR repository used by the deployment workflow."
  value       = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.api.name
}

output "ecs_service_name" {
  value = aws_ecs_service.api.name
}
