output "deployment" {
  description = "Non-secret contract consumed by the Wrangler deployment wrapper."
  value = {
    account_id    = var.cloudflare_account_id
    worker_name   = var.worker_name
    endpoint_mode = var.endpoint_mode
    zone_id       = var.cloudflare_zone_id
    hostname      = var.hostname
    source_ips    = local.source_ips
    endpoints = {
      for key, endpoint in var.endpoints : key => {
        path           = endpoint.path
        access_list_id = cloudflare_zero_trust_list.relay[key].id
        policy_id      = cloudflare_zero_trust_access_policy.relay[key].id
        application_id = cloudflare_zero_trust_access_application.relay[key].id
      }
    }
    webhook_url   = "https://${var.hostname}${var.endpoints.github.path}"
    websocket_url = "wss://${var.hostname}${var.endpoints.gitea.path}"
  }
}
