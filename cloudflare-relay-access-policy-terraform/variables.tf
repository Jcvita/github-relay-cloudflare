variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account containing the Worker, Zero Trust lists and Access resources."
  validation {
    condition     = can(regex("^[a-fA-F0-9]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be a 32-character hexadecimal account ID."
  }
}

variable "hostname" {
  type        = string
  description = "Public relay hostname, without scheme, port or path."
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\\.[a-z]{2,}$", var.hostname))
    error_message = "hostname must be a lowercase DNS hostname, without a scheme, port or path."
  }
}

variable "worker_name" {
  type        = string
  default     = "githook-relay-worker"
  description = "Existing Worker name. Renaming creates a different Worker and Durable Object namespace."
  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.worker_name))
    error_message = "worker_name must be a DNS label of at most 63 lowercase characters."
  }
}

variable "endpoint_mode" {
  type        = string
  default     = "custom_domain"
  description = "custom_domain or workers_dev. Preview URLs are disabled in both modes."
  validation {
    condition     = contains(["custom_domain", "workers_dev"], var.endpoint_mode)
    error_message = "endpoint_mode must be custom_domain or workers_dev."
  }
}

variable "cloudflare_zone_id" {
  type        = string
  default     = null
  nullable    = true
  description = "Cloudflare zone containing hostname; required only for custom_domain."
  validation {
    condition     = var.cloudflare_zone_id == null ? true : can(regex("^[a-fA-F0-9]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be null or a 32-character hexadecimal zone ID."
  }
}

variable "gitea_server_public_ips" {
  type        = set(string)
  description = "Nonempty set of Gitea public egress IPv4/IPv6 addresses or CIDRs."
  validation {
    condition = length(var.gitea_server_public_ips) > 0 && alltrue([
      for ip in var.gitea_server_public_ips :
      can(cidrhost(strcontains(ip, "/") ? ip : "${ip}/${strcontains(ip, ":") ? 128 : 32}", 0))
    ])
    error_message = "Supply at least one valid Gitea public IP address or CIDR, without empty entries."
  }
}

variable "endpoints" {
  type = map(object({
    list_name        = string
    list_description = string
    policy_name      = string
    application_name = string
    path             = string
  }))
  description = "Names and paths for the two independent IP-restricted endpoints."
  default = {
    github = {
      list_name        = "github_hooks_ips"
      list_description = "List of GitHub IPs"
      policy_name      = "GitHub Git Hook IP Policy"
      application_name = "GitHub Git Hook"
      path             = "/relay/webhooks/github/push"
    }
    gitea = {
      list_name        = "gitea_server_ips"
      list_description = "List of Gitea IPs"
      policy_name      = "Gitea WebSocket IP Policy"
      application_name = "Gitea WebSocket"
      path             = "/relay/ws"
    }
  }
  validation {
    condition = (
      toset(keys(var.endpoints)) == toset(["github", "gitea"]) &&
      alltrue([for endpoint in values(var.endpoints) :
        can(regex("^[a-z0-9_]+$", endpoint.list_name)) &&
        length(trimspace(endpoint.policy_name)) > 0 &&
        length(trimspace(endpoint.application_name)) > 0 &&
        can(regex("^/[A-Za-z0-9._~/-]+$", endpoint.path)) &&
        alltrue([for segment in slice(split("/", endpoint.path), 1, length(split("/", endpoint.path))) :
          !contains(["", ".", ".."], segment)
        ])
      ]) &&
      length(distinct([for endpoint in values(var.endpoints) : endpoint.list_name])) == 2 &&
      length(distinct([for endpoint in values(var.endpoints) : endpoint.policy_name])) == 2 &&
      length(distinct([for endpoint in values(var.endpoints) : endpoint.path])) == 2 &&
      alltrue(flatten([for key, endpoint in var.endpoints : [
        for other_key, other in var.endpoints :
        key == other_key || !startswith(endpoint.path, "${other.path}/")
      ]]))
    )
    error_message = "Provide github and gitea with distinct script-compatible list names, distinct policy names, nonempty application names and canonical non-root, non-nested paths using nonempty ASCII URL-unreserved segments (no trailing slash, dot segments or encoding)."
  }
}

variable "existing_resources" {
  type = object({
    access_lists = optional(map(string), {})
    policies     = optional(map(string), {})
    applications = optional(map(string), {})
  })
  default     = {}
  description = "Optional existing Zero Trust list, policy and application IDs keyed by github/gitea. The wrapper discovers these before planning."
  validation {
    condition = alltrue(flatten([
      for group in values(var.existing_resources) : [
        for key, id in group : contains(["github", "gitea"], key) && length(trimspace(id)) > 0
      ]
    ]))
    error_message = "Existing resource maps must contain only github/gitea keys and nonempty IDs."
  }
}
