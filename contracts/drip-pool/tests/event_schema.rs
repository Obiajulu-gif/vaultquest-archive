use drip_pool::{DripPool, DripPoolClient, Error, ProposalAction};
use soroban_sdk::{
    symbol_short, vec, Address, Env, IntoVal, Symbol, TryFromVal, Val,
};

const SNAPSHOT: &str = include_str!("../../docs/EVENT_SCHEMA_V1.snapshot");
const DOCUMENTATION: &str = include_str!("../../docs/EVENT_SCHEMA.md");
const SNAPSHOT_START: &str = "<!-- EVENT_SCHEMA_V1_START -->";
const SNAPSHOT_END: &str = "<!-- EVENT_SCHEMA_V1_END -->";
const LOCKUP_LEDGERS: u32 = 120_960;

fn setup() -> (Env, DripPoolClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, DripPool).unwrap();
    let client = DripPoolClient::new(&env, &contract_id);
    let admin = Address::generate(&env);
    (env, client, admin)
}

fn assert_snapshot_entry(key: &str, topics: &str, payload: &str) {
    let expected = format!("{key}|{topics}|{payload}");
    assert!(
        SNAPSHOT.lines().any(|line| line == expected),
        "missing schema snapshot entry: {expected}"
    );
}

fn event_data(env: &Env, namespace: Symbol, action: Symbol) -> Val {
    let expected_topics = vec![env, namespace.into_val(env), action.into_val(env)];
    env.events()
        .all()
        .iter()
        .find_map(|(_, topics, data)| (topics == expected_topics).then_some(data))
        .expect("expected contract event was not emitted")
}

#[test]
fn documentation_and_machine_readable_snapshot_are_identical() {
    let embedded = DOCUMENTATION
        .split_once(SNAPSHOT_START)
        .expect("documentation is missing snapshot start marker")
        .1
        .split_once(SNAPSHOT_END)
        .expect("documentation is missing snapshot end marker")
        .0
        .trim();

    assert_eq!(embedded, SNAPSHOT.trim());
}

#[test]
fn pool_created_schema_matches_snapshot() {
    assert_snapshot_entry("pool.created", "pool,created", "Address(admin)");

    let (env, client, admin) = setup();
    client.create(&admin);

    let data = event_data(&env, symbol_short!("pool"), symbol_short!("created"));
    let emitted_admin = Address::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_admin, admin);
}

#[test]
fn pool_joined_schema_matches_snapshot() {
    assert_snapshot_entry("pool.joined", "pool,joined", "Address(wallet)");

    let (env, client, admin) = setup();
    client.create(&admin);
    let wallet = Address::generate(&env);
    client.join(&wallet);

    let data = event_data(&env, symbol_short!("pool"), symbol_short!("joined"));
    let emitted_wallet = Address::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_wallet, wallet);
}

#[test]
fn deposit_schema_matches_snapshot_and_payload_positions() {
    assert_snapshot_entry(
        "pool.deposit",
        "pool,deposit",
        "(Address(wallet),i128(amount),i128(total_deposited))",
    );

    let (env, client, admin) = setup();
    client.create(&admin);
    let wallet = Address::generate(&env);
    client.join(&wallet);
    client.deposit(&wallet, &500);

    let data = event_data(&env, symbol_short!("pool"), symbol_short!("deposit"));
    let (emitted_wallet, amount, total_deposited) =
        <(Address, i128, i128)>::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_wallet, wallet);
    assert_eq!(amount, 500);
    assert_eq!(total_deposited, 500);
}

#[test]
fn claim_schema_matches_snapshot_and_payload_positions() {
    assert_snapshot_entry(
        "pool.claimed",
        "pool,claimed",
        "(Address(wallet),i128(amount))",
    );

    let (env, client, admin) = setup();
    client.create(&admin);
    let wallet = Address::generate(&env);
    client.join(&wallet);
    client.deposit(&wallet, &75);
    client.claim(&wallet);

    let data = event_data(&env, symbol_short!("pool"), symbol_short!("claimed"));
    let (emitted_wallet, amount) =
        <(Address, i128)>::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_wallet, wallet);
    assert_eq!(amount, 75);
}

#[test]
fn withdraw_schema_matches_snapshot_and_payload_positions() {
    assert_snapshot_entry(
        "pool.withdrawn",
        "pool,withdrawn",
        "(Address(wallet),i128(amount))",
    );

    let (env, client, admin) = setup();
    client.create(&admin);
    let wallet = Address::generate(&env);
    client.join(&wallet);
    client.deposit(&wallet, &200);
    env.ledger()
        .set_sequence(env.ledger().sequence() + LOCKUP_LEDGERS + 1);
    client.withdraw(&wallet);

    let data = event_data(&env, symbol_short!("pool"), symbol_short!("withdrawn"));
    let (emitted_wallet, amount) =
        <(Address, i128)>::try_from_val(&env, &data).unwrap();
    assert_eq!(emitted_wallet, wallet);
    assert_eq!(amount, 200);
}

#[test]
fn payout_schema_matches_snapshot_and_payload_positions() {
    assert_snapshot_entry(
        "pool.payout",
        "pool,payout",
        "(Address(winner),i128(prize))",
    );

    let (env, client, admin) = setup();
    client.create(&admin);
    client.draw_winner(&admin, &125);

    let data = event_data(&env, symbol_short!("pool"), symbol_short!("payout"));
    let (winner, prize) = <(Address, i128)>::try_from_val(&env, &data).unwrap();
    assert_eq!(winner, admin);
    assert_eq!(prize, 125);
}

#[test]
fn admin_mutations_have_explicit_no_event_contract() {
    for key in [
        "admin.add_admin",
        "admin.remove_admin",
        "admin.propose",
        "admin.approve",
    ] {
        assert_snapshot_entry(key, "none", "none");
    }

    let (env, client, admin) = setup();
    client.create(&admin);
    let baseline = env.events().all().len();

    let second_admin = Address::generate(&env);
    client.add_admin(&admin, &second_admin);
    assert_eq!(env.events().all().len(), baseline);

    client.remove_admin(&admin, &second_admin);
    assert_eq!(env.events().all().len(), baseline);

    client.add_admin(&admin, &second_admin);
    let third_admin = Address::generate(&env);
    let proposal_id = client.propose(&admin, &ProposalAction::AddAdmin(third_admin));
    assert_eq!(env.events().all().len(), baseline);

    client.approve(&second_admin, &proposal_id);
    assert_eq!(env.events().all().len(), baseline);
}

#[test]
fn rejected_calls_do_not_append_success_events() {
    assert_snapshot_entry("error.invalid_amount", "none", "none");
    assert_snapshot_entry("error.unauthorized", "none", "none");

    let (env, client, admin) = setup();
    client.create(&admin);
    let wallet = Address::generate(&env);
    client.join(&wallet);
    let baseline = env.events().all().len();

    assert_eq!(
        client.try_deposit(&wallet, &0),
        Err(Ok(Error::InvalidAmount))
    );
    assert_eq!(env.events().all().len(), baseline);

    let unauthorized = Address::generate(&env);
    assert_eq!(
        client.try_draw_winner(&unauthorized, &100),
        Err(Ok(Error::Unauthorized))
    );
    assert_eq!(env.events().all().len(), baseline);
}
