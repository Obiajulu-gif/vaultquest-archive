use drip_pool::{DripPool, DripPoolClient, Error, ProposalAction};
use serde_json::Value as JsonValue;
use soroban_sdk::{
    testutils::{Address as _, Events as _, Ledger as _},
    Address, Env, IntoVal, Symbol, TryFromVal, Val,
};

fn setup() -> (Env, DripPoolClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, DripPool).unwrap();
    let client = DripPoolClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    (env, client, admin)
}

fn snapshot() -> JsonValue {
    let document = include_str!("../../docs/EVENT_SCHEMA.md");
    let marked = document
        .split("<!-- EVENT_SCHEMA_SNAPSHOT_START -->")
        .nth(1)
        .expect("EVENT_SCHEMA snapshot start marker is missing")
        .split("<!-- EVENT_SCHEMA_SNAPSHOT_END -->")
        .next()
        .expect("EVENT_SCHEMA snapshot end marker is missing");
    let json = marked
        .split("```json")
        .nth(1)
        .expect("EVENT_SCHEMA JSON fence is missing")
        .split("```")
        .next()
        .expect("EVENT_SCHEMA JSON fence is not closed");
    serde_json::from_str(json).expect("EVENT_SCHEMA snapshot must be valid JSON")
}

fn event_data(env: &Env, action: &str) -> Val {
    let expected_topics = soroban_sdk::vec![
        env,
        Symbol::new(env, "pool").into_val(env),
        Symbol::new(env, action).into_val(env),
    ];

    env.events()
        .all()
        .iter()
        .find_map(|(_, topics, data)| {
            if topics == expected_topics {
                Some(data)
            } else {
                None
            }
        })
        .unwrap_or_else(|| panic!("event pool/{action} not found"))
}

#[test]
fn documented_snapshot_lists_every_contract_v1_event_and_payload_position() {
    let schema = snapshot();
    assert_eq!(schema["schema"], "contract-v1");
    assert_eq!(schema["topics"], serde_json::json!(["domain", "action"]));

    let events = schema["events"]
        .as_array()
        .expect("events must be an array");
    let compact: Vec<(&str, Vec<&str>, Vec<&str>)> = events
        .iter()
        .map(|event| {
            let name = event["name"].as_str().unwrap();
            let topics = event["topics"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            let payload = event["payload"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect();
            (name, topics, payload)
        })
        .collect();

    assert_eq!(
        compact,
        vec![
            ("pool_created", vec!["pool", "created"], vec!["admin"]),
            ("pool_joined", vec!["pool", "joined"], vec!["wallet"]),
            (
                "drip_deposited",
                vec!["pool", "deposit"],
                vec!["wallet", "amount", "total_deposited"],
            ),
            (
                "reward_claimed",
                vec!["pool", "claimed"],
                vec!["wallet", "amount"],
            ),
            (
                "withdrawn",
                vec!["pool", "withdrawn"],
                vec!["wallet", "amount"],
            ),
            (
                "payout_selected",
                vec!["pool", "payout"],
                vec!["winner", "amount"],
            ),
        ]
    );
}

#[test]
fn emitted_topics_and_payload_shapes_match_the_documented_snapshot() {
    let (env, client, admin) = setup();
    client.create(&admin);

    let created = Address::try_from_val(&env, &event_data(&env, "created")).unwrap();
    assert_eq!(created, admin);

    let alice = Address::generate(&env);
    client.join(&alice);
    let joined = Address::try_from_val(&env, &event_data(&env, "joined")).unwrap();
    assert_eq!(joined, alice);

    client.deposit(&alice, &500);
    let deposited =
        <(Address, i128, i128)>::try_from_val(&env, &event_data(&env, "deposit")).unwrap();
    assert_eq!(deposited, (alice.clone(), 500, 500));

    client.claim_reward(&alice);
    let claimed = <(Address, i128)>::try_from_val(&env, &event_data(&env, "claimed")).unwrap();
    assert_eq!(claimed, (alice.clone(), 500));

    env.ledger().set_sequence(env.ledger().sequence() + 120_961);
    client.withdraw(&alice);
    let withdrawn = <(Address, i128)>::try_from_val(&env, &event_data(&env, "withdrawn")).unwrap();
    assert_eq!(withdrawn, (alice, 500));

    client.draw_winner(&admin, &100);
    let payout = <(Address, i128)>::try_from_val(&env, &event_data(&env, "payout")).unwrap();
    assert_eq!(payout, (admin, 100));
}

#[test]
fn documented_non_emitting_admin_and_error_paths_remain_explicit() {
    let schema = snapshot();
    assert_eq!(
        schema["non_emitting_admin_actions"],
        serde_json::json!(["add_admin", "remove_admin", "propose", "approve"])
    );
    assert_eq!(schema["errors"]["emitted"], false);

    let (env, client, admin) = setup();
    client.create(&admin);
    let event_count = env.events().all().len();

    let second_admin = Address::generate(&env);
    client.add_admin(&admin, &second_admin);
    client.remove_admin(&admin, &second_admin);
    let proposal_id = client.propose(&admin, &ProposalAction::AddAdmin(Address::generate(&env)));
    assert_eq!(
        client.try_approve(&admin, &proposal_id),
        Err(Ok(Error::AlreadySigned))
    );
    assert_eq!(env.events().all().len(), event_count);

    assert_eq!(
        client.try_deposit(&admin, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(env.events().all().len(), event_count);
}
