variable "aws_region" {
  description = "AWS region containing the default VPC, queues, and database."
  type        = string
}

variable "cors_origin" {
  description = "Allowed browser origin for the UI."
  type        = string
}

variable "database_host" {
  description = "Hostname of the shared PostgreSQL database."
  type        = string
}

variable "database_port" {
  description = "PostgreSQL port."
  type        = number
  default     = 5432
}

variable "database_name" {
  description = "PostgreSQL database name."
  type        = string
  default     = "inventario"
}

variable "database_user" {
  description = "PostgreSQL username."
  type        = string
}

variable "database_password_secret_arn" {
  description = "Secrets Manager ARN whose secret value is the raw PostgreSQL password."
  type        = string
}

variable "database_security_group_id" {
  description = "Security group attached to the shared database."
  type        = string
}

variable "agent_url" {
  description = "Base URL of the agent service."
  type        = string
  default     = ""
}

variable "agent_function_name" {
  description = "Lambda del agente (hack-saltillo-events) que la API invoca para el chat y las notificaciones. Vacía = sin agente."
  type        = string
  default     = "hack-saltillo-events-agent"
}

variable "image_tag" {
  description = "Immutable image tag to deploy."
  type        = string
  default     = "bootstrap"
}
