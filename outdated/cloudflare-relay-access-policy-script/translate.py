from cloudflare.types.zero_trust.access import PolicyGetResponse, PolicyListResponse
from cloudflare.types.zero_trust.access.policy_get_response import (
    ConnectionRules as PolicyGetConnectionRules,
    ConnectionRulesRDP as PolicyGetConnectionRulesRDP,
    MfaConfig as PolicyGetMfaConfig,
)
from cloudflare.types.zero_trust.access.policy_list_response import (
    ConnectionRules as PolicyListConnectionRules,
    ConnectionRulesRDP as PolicyListConnectionRulesRDP,
    MfaConfig as PolicyListMfaConfig,
)
from cloudflare.types.rules import ListGetResponse, ListsList


def list_lists_to_list_get_response(lists: ListsList) -> ListGetResponse:
    return ListGetResponse(
        id=lists.id,
        name=lists.name,
        kind=lists.kind,
        description=lists.description,
        num_items=lists.num_items,
        created_on=lists.created_on,
        modified_on=lists.modified_on,
        num_referencing_filters=lists.num_referencing_filters
    )


def policy_list_connection_rules_rdp_to_policy_get_connection_rules_rdp(
    rules: PolicyListConnectionRulesRDP | None,
) -> PolicyGetConnectionRulesRDP | None:
    if rules is None:
        return None
    return PolicyGetConnectionRulesRDP(
        allowed_clipboard_local_to_remote_formats=rules.allowed_clipboard_local_to_remote_formats,
        allowed_clipboard_remote_to_local_formats=rules.allowed_clipboard_remote_to_local_formats,
    )


def policy_list_connection_rules_to_policy_get_connection_rules(
    rules: PolicyListConnectionRules | None,
) -> PolicyGetConnectionRules | None:
    if rules is None:
        return None
    return PolicyGetConnectionRules(
        rdp=policy_list_connection_rules_rdp_to_policy_get_connection_rules_rdp(rules.rdp),
    )


def policy_list_mfa_config_to_policy_get_mfa_config(
    config: PolicyListMfaConfig | None,
) -> PolicyGetMfaConfig | None:
    if config is None:
        return None
    return PolicyGetMfaConfig(
        allowed_authenticators=config.allowed_authenticators,
        mfa_disabled=config.mfa_disabled,
        session_duration=config.session_duration,
    )


def policy_list_response_to_policy_get_response(policy: PolicyListResponse) -> PolicyGetResponse:
    return PolicyGetResponse(
        id=policy.id,
        account_id=policy.account_id,
        app_count=policy.app_count,
        approval_groups=policy.approval_groups,
        approval_required=policy.approval_required,
        connection_rules=policy_list_connection_rules_to_policy_get_connection_rules(policy.connection_rules),
        created_at=policy.created_at,
        decision=policy.decision,
        exclude=policy.exclude,
        include=policy.include,
        isolation_required=policy.isolation_required,
        mfa_config=policy_list_mfa_config_to_policy_get_mfa_config(policy.mfa_config),
        name=policy.name,
        purpose_justification_prompt=policy.purpose_justification_prompt,
        purpose_justification_required=policy.purpose_justification_required,
        require=policy.require,
        reusable=policy.reusable,
        session_duration=policy.session_duration,
        updated_at=policy.updated_at,
    )
