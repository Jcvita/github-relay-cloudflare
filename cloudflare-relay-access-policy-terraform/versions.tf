terraform {
  required_version = ">= 1.7, < 2.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "= 5.28.0"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.5"
    }
  }
}

# Both Terraform and Wrangler read CLOUDFLARE_API_TOKEN from the environment.
provider "cloudflare" {}
