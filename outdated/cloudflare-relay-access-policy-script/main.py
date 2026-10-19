from collections.abc import Iterable

from cloudflare import Cloudflare
from cloudflare.types.rules import ListGetResponse
from cloudflare.types.rules.lists.item_create_params import BodyListsListItemIPComment
from cloudflare.types.rules.lists.item_list_response import ItemListResponse, ListsListItemIPFull
from cloudflare.types.zero_trust.access import PolicyGetResponse
from cloudflare.types.zero_trust.access.application_create_params import (
    SelfHostedApplicationPolicyAccessAppPolicyLink as CreateApplicationPolicyLink,
)
from cloudflare.types.zero_trust.access.application_create_response import (
    SelfHostedApplication as CreatedSelfHostedApplication,
)
from cloudflare.types.zero_trust.access.application_get_response import (
    SelfHostedApplication as SelfHostedApplication,
)
from cloudflare.types.zero_trust.access.application_list_response import (
    SelfHostedApplication as ListedSelfHostedApplication,
)
from cloudflare.types.zero_trust.access.application_update_params import (
    SelfHostedApplicationPolicyAccessAppPolicyLink as UpdateApplicationPolicyLink,
)
from cloudflare.types.zero_trust.access.applications.ip_list_rule import IPListRule
from cloudflare.types.zero_trust.access.applications.ip_list_rule_param import IPListRuleParam
from translate import list_lists_to_list_get_response, policy_list_response_to_policy_get_response

import os
import requests
from dotenv import load_dotenv

def get_github_hooks_ips() -> list[str]:
    response = requests.get("https://api.github.com/meta")
    response.raise_for_status()
    return response.json().get("hooks", [])

def create_github_ip_list_entries() -> list[BodyListsListItemIPComment]:
    hooks_ips = get_github_hooks_ips()
    return [{"ip": ip, "comment": f"GitHub Hooks IP Block {index}"} for index, ip in enumerate(hooks_ips)]

def create_gitea_ip_list_entries(ips: list[str]) -> list[BodyListsListItemIPComment]:
    return [{"ip": ip, "comment": f"Gitea IP Block {index}"} for index, ip in enumerate(ips)]

def get_ip_addresses(items: Iterable[ItemListResponse]) -> set[str]:
    ip_addresses = set()
    for item in items:
        if not isinstance(item, ListsListItemIPFull):
            raise TypeError(f"Expected an IP list item, got {type(item).__name__}")
        ip_addresses.add(item.ip)
    return ip_addresses

def get_list_by_name_or_id(cf_client: Cloudflare, account_id: str, list_id: str | None, list_name: str | None) -> ListGetResponse | None:
    if list_id is None and list_name is None:
        return None
    if list_id:
        return cf_client.rules.lists.get(account_id=account_id, list_id=list_id)
    if list_name:
        all_lists = cf_client.rules.lists.list(account_id=account_id)
        for lst in all_lists:
            if lst.name == list_name:
                return list_lists_to_list_get_response(lst)
        return None
    return None

def get_ac_policy_by_name_or_id(cf_client: Cloudflare, account_id: str, policy_id: str | None, policy_name: str | None) -> PolicyGetResponse | None:
    if policy_id is None and policy_name is None:
        return None
    if policy_id:
        return cf_client.zero_trust.access.policies.get(account_id=account_id, policy_id=policy_id)
    if policy_name:
        all_policies = cf_client.zero_trust.access.policies.list(account_id=account_id)
        for policy in all_policies:
            if policy.name == policy_name:
                return policy_list_response_to_policy_get_response(policy)
        return None
    return None

def get_access_application_by_id_or_domain(
    cf_client: Cloudflare,
    account_id: str,
    application_id: str | None,
    domain: str,
) -> SelfHostedApplication | None:
    applications = cf_client.zero_trust.access.applications
    if application_id:
        application = applications.get(account_id=account_id, app_id=application_id)
        if application is None:
            raise RuntimeError(f"Access application {application_id!r} was not found")
        if not isinstance(application, SelfHostedApplication):
            raise TypeError(f"Access application {application_id!r} is not a self-hosted application")
        return application

    for listed_application in applications.list(account_id=account_id, domain=domain, exact=True):
        if not isinstance(listed_application, ListedSelfHostedApplication):
            continue
        if listed_application.domain != domain:
            continue
        if listed_application.id is None:
            raise RuntimeError(f"Access application for {domain!r} has no ID")
        application = applications.get(account_id=account_id, app_id=listed_application.id)
        if application is None:
            raise RuntimeError(f"Access application {listed_application.id!r} could not be retrieved")
        if not isinstance(application, SelfHostedApplication):
            raise TypeError(f"Access application {listed_application.id!r} is not a self-hosted application")
        return application
    return None

def ensure_policy_contains_ip_lists(
    cf_client: Cloudflare,
    account_id: str,
    policy: PolicyGetResponse,
    policy_name: str,
    ip_list_ids: set[str],
    include_rules: list[IPListRuleParam],
) -> PolicyGetResponse:
    policy_id = policy.id
    if policy_id is None:
        raise RuntimeError("The Access policy response did not include an ID")

    included_rules = policy.include or []
    included_ip_list_ids = {
        rule.ip_list.id
        for rule in included_rules
        if isinstance(rule, IPListRule)
    }
    if (
        policy.decision != "allow"
        or included_ip_list_ids != ip_list_ids
        or len(included_rules) != len(ip_list_ids)
    ):
        cf_client.zero_trust.access.policies.update(
            account_id=account_id,
            policy_id=policy_id,
            name=policy.name or policy_name,
            decision="allow",
            include=include_rules,
        )
        updated_policy = cf_client.zero_trust.access.policies.get(
            account_id=account_id,
            policy_id=policy_id,
        )
        if updated_policy is None:
            raise RuntimeError(f"Access policy {policy_id!r} could not be retrieved after updating")
        policy = updated_policy

    updated_ip_list_ids = {
        rule.ip_list.id
        for rule in policy.include or []
        if isinstance(rule, IPListRule)
    }
    if (
        policy.decision != "allow"
        or updated_ip_list_ids != ip_list_ids
        or len(policy.include or []) != len(ip_list_ids)
    ):
        raise RuntimeError(f"Access policy {policy_id!r} does not contain only its configured IP list")
    return policy

def ensure_access_policy(
    cf_client: Cloudflare,
    account_id: str,
    policy_id: str | None,
    policy_name: str,
    ip_list_id: str,
) -> PolicyGetResponse:
    include_rules = [IPListRuleParam(ip_list={"id": ip_list_id})]
    policy = get_ac_policy_by_name_or_id(cf_client, account_id, policy_id, policy_name)
    if policy is None:
        if policy_id:
            raise RuntimeError(f"Access policy {policy_id!r} was not found")
        print(f"Access policy {policy_name!r} not found. Creating...")
        created_policy = cf_client.zero_trust.access.policies.create(
            account_id=account_id,
            name=policy_name,
            decision="allow",
            include=include_rules,
        )
        if created_policy is None or created_policy.id is None:
            raise RuntimeError(f"Cloudflare did not return an ID for Access policy {policy_name!r}")
        policy = cf_client.zero_trust.access.policies.get(
            account_id=account_id,
            policy_id=created_policy.id,
        )
        if policy is None:
            raise RuntimeError(f"Created Access policy {created_policy.id!r} could not be retrieved")

    return ensure_policy_contains_ip_lists(
        cf_client,
        account_id,
        policy,
        policy_name,
        {ip_list_id},
        include_rules,
    )

def ensure_policy_applied_to_access_application(
    cf_client: Cloudflare,
    account_id: str,
    application: SelfHostedApplication,
    policy_id: str,
) -> SelfHostedApplication:
    if application.type != "self_hosted":
        raise TypeError(f"Access application {application.id!r} is not self-hosted")
    application_id = application.id
    if application_id is None:
        raise RuntimeError("The Access application response did not include an ID")

    attached_policies = application.policies or []
    if len(attached_policies) == 1 and attached_policies[0].id == policy_id:
        return application

    policy_links: list[UpdateApplicationPolicyLink] = [{"id": policy_id, "precedence": 1}]
    cf_client.zero_trust.access.applications.update(
        account_id=account_id,
        app_id=application_id,
        domain=application.domain,
        type="self_hosted",
        policies=policy_links,
    )

    updated_application = cf_client.zero_trust.access.applications.get(
        account_id=account_id,
        app_id=application_id,
    )
    if updated_application is None or not isinstance(updated_application, SelfHostedApplication):
        raise RuntimeError(f"Access application {application_id!r} could not be retrieved after updating")
    applied_policies = updated_application.policies or []
    if len(applied_policies) != 1 or applied_policies[0].id != policy_id:
        raise RuntimeError(f"Access application {application_id!r} does not have only policy {policy_id!r}")
    return updated_application

def get_access_application_domain(hostname: str, path: str) -> str:
    if not hostname or "://" in hostname or "/" in hostname:
        raise ValueError("CLOUDFLARE_ACCESS_APPLICATION_DOMAIN must be a hostname without a scheme or path")
    if not path.startswith("/"):
        raise ValueError("CLOUDFLARE_ACCESS_APPLICATION_PATH must start with '/'")
    return f"{hostname.rstrip('/')}{path}"

def ensure_access_application(
    cf_client: Cloudflare,
    account_id: str,
    application_id: str | None,
    application_name: str,
    domain: str,
    policy_id: str,
) -> SelfHostedApplication:
    application = get_access_application_by_id_or_domain(
        cf_client,
        account_id,
        application_id,
        domain,
    )
    if application is None:
        print(f"Access application for {domain} not found. Creating...")
        policy_link: CreateApplicationPolicyLink = {"id": policy_id, "precedence": 1}
        created_application = cf_client.zero_trust.access.applications.create(
            account_id=account_id,
            domain=domain,
            name=application_name,
            type="self_hosted",
            policies=[policy_link],
        )
        if not isinstance(created_application, CreatedSelfHostedApplication) or created_application.id is None:
            raise RuntimeError(f"Cloudflare did not return an ID for Access application {domain!r}")
        application = get_access_application_by_id_or_domain(
            cf_client,
            account_id,
            created_application.id,
            domain,
        )
        if application is None:
            raise RuntimeError(f"Created Access application {created_application.id!r} could not be retrieved")
    elif application.domain != domain:
        raise ValueError(
            f"Access application {application.id!r} secures {application.domain!r}, "
            f"not the configured domain and path {domain!r}"
        )

    return ensure_policy_applied_to_access_application(
        cf_client,
        account_id,
        application,
        policy_id,
    )

def main():
    load_dotenv()

    api_token = os.getenv('CLOUDFLARE_API_TOKEN') or exit("CLOUDFLARE_API_TOKEN is not set")
    account_id = os.getenv('CLOUDFLARE_ACCOUNT_ID') or exit("CLOUDFLARE_ACCOUNT_ID is not set")

    cf = Cloudflare(api_token=api_token)

    gitea_ip_list_id = os.getenv('CLOUDFLARE_GITEA_IP_LIST_ID')
    gitea_ip_list_name = os.getenv('CLOUDFLARE_GITEA_IP_LIST_NAME')
    github_ip_list_id = os.getenv('CLOUDFLARE_GITHUB_IP_LIST_ID')
    github_ip_list_name = os.getenv('CLOUDFLARE_GITHUB_IP_LIST_NAME')

    # Assert that GitHub IP list exists and is contains up-to-date IPs
    cloudflare_github_list = get_list_by_name_or_id(cf, account_id, github_ip_list_id, github_ip_list_name)
    if cloudflare_github_list is None:
        print("GitHub IP list not found. Creating new list...")
        cloudflare_github_list = cf.rules.lists.create(
            account_id=account_id,
            name=github_ip_list_name or "GitHub Hooks IP List",
            kind="ip",
            description="List of GitHub IPs",
        )
        # Asynchronomous. Figure out how to cleanly await before continuing if determined necessary or retry until not rejected.
        cf.rules.lists.items.create(
            account_id=account_id,
            list_id=cloudflare_github_list.id,
            body=create_github_ip_list_entries()
        )
    else:
        print("GitHub IP list found:", cloudflare_github_list.id)
        print("Checking if list items match current GitHub Hooks IPs...")
        current_items = cf.rules.lists.items.list(
            account_id=account_id,
            list_id=cloudflare_github_list.id
        )
        github_ips = get_ip_addresses(current_items)
        expected_ips = {entry["ip"] for entry in create_github_ip_list_entries()}
        if github_ips != expected_ips:
            print("GitHub IP list items do not match current GitHub Hooks IPs. Updating...")
            cf.rules.lists.items.update(
                account_id=account_id,
                list_id=cloudflare_github_list.id,
                body=create_github_ip_list_entries()
            )

    # Assert that Gitea IP list exists and is contains up-to-date IPs
    gitea_server_public_ips = (os.getenv('GITEA_SERVER_PUBLIC_IPS') or '').split(',')
    
    cloudflare_gitea_list = get_list_by_name_or_id(cf, account_id, gitea_ip_list_id, gitea_ip_list_name)
    if cloudflare_gitea_list is None:
        print("Gitea IP list not found. Creating new list...")
        cloudflare_gitea_list = cf.rules.lists.create(
            account_id=account_id,
            name=gitea_ip_list_name or "Gitea IP List",
            kind="ip",
            description="List of Gitea IPs",
        )
        # Asynchronous
        cf.rules.lists.items.create(
            account_id=account_id,
            list_id=cloudflare_gitea_list.id,
            body=create_gitea_ip_list_entries(gitea_server_public_ips)
        )
    else:
        print("Gitea IP list found:", cloudflare_gitea_list.id)
        print("Checking if list items match current Gitea server public IPs...")
        current_items = cf.rules.lists.items.list(
            account_id=account_id,
            list_id=cloudflare_gitea_list.id
        )
        gitea_ips = get_ip_addresses(current_items)
        expected_ips = {entry["ip"] for entry in create_gitea_ip_list_entries(gitea_server_public_ips)}
        if gitea_ips != expected_ips:
            print("Gitea IP list items do not match current Gitea server public IPs. Updating...")
            # Asynchronous
            cf.rules.lists.items.update(
                account_id=account_id,
                list_id=cloudflare_gitea_list.id,
                body=create_gitea_ip_list_entries(gitea_server_public_ips)
            )

    github_policy = ensure_access_policy(
        cf,
        account_id,
        os.getenv("CLOUDFLARE_GITHUB_AC_POLICY_ID"),
        os.getenv("CLOUDFLARE_GITHUB_AC_POLICY_NAME") or "GitHub Git Hook IP Policy",
        cloudflare_github_list.id,
    )
    gitea_policy = ensure_access_policy(
        cf,
        account_id,
        os.getenv("CLOUDFLARE_GITEA_AC_POLICY_ID"),
        os.getenv("CLOUDFLARE_GITEA_AC_POLICY_NAME") or "Gitea WebSocket IP Policy",
        cloudflare_gitea_list.id,
    )
    if github_policy.id is None or gitea_policy.id is None:
        raise RuntimeError("Cloudflare did not return IDs for both Access policies")

    access_application_hostname = (
        os.getenv("CLOUDFLARE_ACCESS_APPLICATION_DOMAIN")
        or exit("CLOUDFLARE_ACCESS_APPLICATION_DOMAIN is not set")
    )
    github_application_domain = get_access_application_domain(
        access_application_hostname,
        os.getenv("CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH")
        or exit("CLOUDFLARE_GITHUB_ACCESS_APPLICATION_PATH is not set"),
    )
    gitea_application_domain = get_access_application_domain(
        access_application_hostname,
        os.getenv("CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH")
        or exit("CLOUDFLARE_GITEA_ACCESS_APPLICATION_PATH is not set"),
    )

    github_application = ensure_access_application(
        cf,
        account_id,
        os.getenv("CLOUDFLARE_GITHUB_ACCESS_APPLICATION_ID"),
        os.getenv("CLOUDFLARE_GITHUB_ACCESS_APPLICATION_NAME") or "GitHub Git Hook",
        github_application_domain,
        github_policy.id,
    )
    gitea_application = ensure_access_application(
        cf,
        account_id,
        os.getenv("CLOUDFLARE_GITEA_ACCESS_APPLICATION_ID"),
        os.getenv("CLOUDFLARE_GITEA_ACCESS_APPLICATION_NAME") or "Gitea WebSocket",
        gitea_application_domain,
        gitea_policy.id,
    )
    print(f"GitHub Access policy {github_policy.id} is applied to application {github_application.id}.")
    print(f"Gitea Access policy {gitea_policy.id} is applied to application {gitea_application.id}.")



if __name__ == "__main__":
    main()