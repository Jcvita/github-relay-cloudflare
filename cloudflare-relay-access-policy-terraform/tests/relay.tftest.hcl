mock_provider "cloudflare" {}

mock_provider "http" {
  mock_data "http" {
    defaults = {
      status_code   = 200
      response_body = "{\"hooks\":[\"192.30.252.0/22\",\"2a0a:a440::/29\",\"192.30.252.0/22\"],\"web\":[\"198.51.100.0/24\"]}"
    }
  }
}

variables {
  cloudflare_account_id   = "0123456789abcdef0123456789abcdef"
  cloudflare_zone_id      = "abcdef0123456789abcdef0123456789"
  hostname                = "relay.example.com"
  gitea_server_public_ips = ["203.0.113.10", "2001:db8::/48"]
  endpoints = {
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
}

override_resource {
  target = cloudflare_zero_trust_list.relay["github"]
  values = { id = "github-access-list" }
}

override_resource {
  target = cloudflare_zero_trust_list.relay["gitea"]
  values = { id = "gitea-access-list" }
}

run "links_and_exact_membership" {
  command = apply

  assert {
    condition     = toset([for item in cloudflare_zero_trust_list.relay["github"].items : item.value]) == toset(["192.30.252.0/22", "2a0a:a440::/29"])
    error_message = "Zero Trust lists must use only deduplicated GitHub hooks ranges, including IPv6."
  }
  assert {
    condition     = toset([for item in cloudflare_zero_trust_list.relay["github"].items : item.value]) == toset(local.github_hook_ips)
    error_message = "The Access list must contain exactly the GitHub hooks ranges."
  }
  assert {
    condition     = toset([for item in cloudflare_zero_trust_list.relay["gitea"].items : item.value]) == var.gitea_server_public_ips
    error_message = "Gitea must use only its configured public egress addresses."
  }
  assert {
    condition = alltrue([for key, policy in cloudflare_zero_trust_access_policy.relay :
      policy.decision == "non_identity" &&
      length(policy.include) == 1 &&
      one(policy.include).ip_list.id == cloudflare_zero_trust_list.relay[key].id &&
      length(policy.exclude) == 0 && length(policy.require) == 0
    ])
    error_message = "Each Service Auth policy must include exactly its own Zero Trust IP list."
  }
  assert {
    condition = alltrue([for key, app in cloudflare_zero_trust_access_application.relay :
      app.domain == "${var.hostname}${var.endpoints[key].path}" &&
      length(app.destinations) == 1 && app.destinations[0].uri == app.domain &&
      length(app.policies) == 1 && app.policies[0].id == cloudflare_zero_trust_access_policy.relay[key].id
    ])
    error_message = "Each application must protect its exact path and reference only its intended policy."
  }
  assert {
    condition     = output.deployment.webhook_url == "https://relay.example.com/relay/webhooks/github/push" && output.deployment.websocket_url == "wss://relay.example.com/relay/ws"
    error_message = "Endpoint URLs must match the actual Rust routes."
  }
}

run "repeat_apply_is_stable" {
  command = apply
  assert {
    condition     = cloudflare_zero_trust_list.relay["github"].id == run.links_and_exact_membership.deployment.endpoints.github.access_list_id
    error_message = "Repeated applies must preserve the Access list identity."
  }
}

run "workers_dev_mode" {
  command = plan
  variables {
    endpoint_mode      = "workers_dev"
    hostname           = "githook-relay-worker.example.workers.dev"
    cloudflare_zone_id = null
  }
  assert {
    condition     = cloudflare_zero_trust_access_application.relay["github"].domain == "githook-relay-worker.example.workers.dev/relay/webhooks/github/push"
    error_message = "workers.dev must protect the same exact webhook path."
  }
}

run "custom_paths_update_destinations_and_outputs" {
  command = plan
  variables {
    endpoints = {
      github = merge(var.endpoints.github, { path = "/custom/github-hook" })
      gitea  = merge(var.endpoints.gitea, { path = "/custom/socket" })
    }
  }
  assert {
    condition = (
      cloudflare_zero_trust_access_application.relay["github"].domain == "relay.example.com/custom/github-hook" &&
      cloudflare_zero_trust_access_application.relay["github"].destinations[0].uri == "relay.example.com/custom/github-hook" &&
      cloudflare_zero_trust_access_application.relay["gitea"].destinations[0].uri == "relay.example.com/custom/socket" &&
      output.deployment.webhook_url == "https://relay.example.com/custom/github-hook" &&
      output.deployment.websocket_url == "wss://relay.example.com/custom/socket"
    )
    error_message = "Custom paths must update both Access destinations and all deployment outputs."
  }
}

run "nested_paths_fail" {
  command = plan
  variables {
    endpoints = {
      github = merge(var.endpoints.github, { path = "/relay" })
      gitea  = var.endpoints.gitea
    }
  }
  expect_failures = [var.endpoints]
}

run "identical_paths_fail" {
  command = plan
  variables {
    endpoints = {
      github = merge(var.endpoints.github, { path = var.endpoints.gitea.path })
      gitea  = var.endpoints.gitea
    }
  }
  expect_failures = [var.endpoints]
}

run "encoded_paths_fail" {
  command = plan
  variables {
    endpoints = {
      github = merge(var.endpoints.github, { path = "/custom%2fhook" })
      gitea  = var.endpoints.gitea
    }
  }
  expect_failures = [var.endpoints]
}

run "dot_segment_paths_fail" {
  command = plan
  variables {
    endpoints = {
      github = merge(var.endpoints.github, { path = "/custom/../hook" })
      gitea  = var.endpoints.gitea
    }
  }
  expect_failures = [var.endpoints]
}

run "trailing_slash_paths_fail" {
  command = plan
  variables {
    endpoints = {
      github = merge(var.endpoints.github, { path = "/custom/hook/" })
      gitea  = var.endpoints.gitea
    }
  }
  expect_failures = [var.endpoints]
}

run "empty_github_ranges_fail_closed" {
  command = plan
  override_data {
    target = data.http.github_meta
    values = { status_code = 200, response_body = "{\"hooks\":[]}" }
  }
  expect_failures = [data.http.github_meta]
}

run "invalid_github_ranges_fail_closed" {
  command = plan
  override_data {
    target = data.http.github_meta
    values = { status_code = 200, response_body = "{\"hooks\":[\"not-a-cidr\"]}" }
  }
  expect_failures = [data.http.github_meta]
}

run "missing_github_hooks_fail_closed" {
  command = plan
  override_data {
    target = data.http.github_meta
    values = { status_code = 200, response_body = "{\"web\":[\"192.0.2.0/24\"]}" }
  }
  expect_failures = [data.http.github_meta]
}

run "non_array_github_hooks_fail_closed" {
  command = plan
  override_data {
    target = data.http.github_meta
    values = { status_code = 200, response_body = "{\"hooks\":{\"range\":\"192.0.2.0/24\"}}" }
  }
  expect_failures = [data.http.github_meta]
}

run "malformed_github_json_fails_closed" {
  command = plan
  override_data {
    target = data.http.github_meta
    values = { status_code = 200, response_body = "not-json" }
  }
  expect_failures = [data.http.github_meta]
}

run "github_http_error_fails_closed" {
  command = plan
  override_data {
    target = data.http.github_meta
    values = { status_code = 503, response_body = "{\"hooks\":[\"192.0.2.0/24\"]}" }
  }
  expect_failures = [data.http.github_meta]
}

run "empty_gitea_ranges_fail_closed" {
  command = plan
  variables {
    gitea_server_public_ips = []
  }
  expect_failures = [var.gitea_server_public_ips]
}

run "custom_domain_requires_zone" {
  command = plan
  variables {
    cloudflare_zone_id = null
  }
  expect_failures = [
    cloudflare_zero_trust_access_application.relay["github"],
    cloudflare_zero_trust_access_application.relay["gitea"],
  ]
}
