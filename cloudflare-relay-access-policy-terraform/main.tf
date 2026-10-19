data "http" "github_meta" {
  url = "https://api.github.com/meta"
  request_headers = {
    Accept               = "application/vnd.github+json"
    X-GitHub-Api-Version = "2022-11-28"
    User-Agent           = "cloudflare-github-relay-terraform"
  }
  request_timeout_ms = 30000
  retry {
    attempts     = 3
    min_delay_ms = 1000
    max_delay_ms = 5000
  }
  lifecycle {
    postcondition {
      condition = self.status_code == 200 && try(
        length(tolist(jsondecode(self.response_body).hooks)) > 0 &&
        alltrue([for ip in jsondecode(self.response_body).hooks : can(cidrhost(ip, 0))]),
        false
      )
      error_message = "GitHub /meta must return HTTP 200 and a nonempty hooks array containing valid CIDRs. Refusing to replace lists with invalid data."
    }
  }
}

locals {
  github_hook_ips = sort(distinct(tolist(jsondecode(data.http.github_meta.response_body).hooks)))
  source_ips = {
    github = local.github_hook_ips
    gitea  = sort(tolist(var.gitea_server_public_ips))
  }
}

# Access does not use Rules lists. Forget legacy mirrors without deleting them.
removed {
  from = cloudflare_list.relay
  lifecycle {
    destroy = false
  }
}

# Access ip_list selectors use Zero Trust lists, not Rules custom lists.
resource "cloudflare_zero_trust_list" "relay" {
  for_each    = var.endpoints
  account_id  = var.cloudflare_account_id
  name        = each.value.list_name
  description = each.value.list_description
  type        = "IP"
  items       = [for ip in local.source_ips[each.key] : { value = ip }]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_policy" "relay" {
  for_each   = var.endpoints
  account_id = var.cloudflare_account_id
  name       = each.value.policy_name
  decision   = "non_identity"
  include    = [{ ip_list = { id = cloudflare_zero_trust_list.relay[each.key].id } }]
  exclude    = []
  require    = []

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_zero_trust_access_application" "relay" {
  for_each   = var.endpoints
  account_id = var.cloudflare_account_id
  name       = each.value.application_name
  domain     = "${var.hostname}${each.value.path}"
  type       = "self_hosted"
  destinations = [{
    type = "public"
    uri  = "${var.hostname}${each.value.path}"
  }]
  app_launcher_visible      = false
  auto_redirect_to_identity = false
  service_auth_401_redirect = false
  policies = [{
    id         = cloudflare_zero_trust_access_policy.relay[each.key].id
    precedence = 1
  }]

  lifecycle {
    prevent_destroy = true
    precondition {
      condition     = var.endpoint_mode != "custom_domain" || var.cloudflare_zone_id != null
      error_message = "custom_domain requires cloudflare_zone_id."
    }
    precondition {
      condition     = var.endpoint_mode != "workers_dev" || endswith(var.hostname, ".workers.dev")
      error_message = "workers_dev requires a workers.dev hostname."
    }
  }
}

import {
  for_each = var.existing_resources.access_lists
  to       = cloudflare_zero_trust_list.relay[each.key]
  id       = "${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = var.existing_resources.policies
  to       = cloudflare_zero_trust_access_policy.relay[each.key]
  id       = "${var.cloudflare_account_id}/${each.value}"
}

import {
  for_each = var.existing_resources.applications
  to       = cloudflare_zero_trust_access_application.relay[each.key]
  id       = "accounts/${var.cloudflare_account_id}/${each.value}"
}
