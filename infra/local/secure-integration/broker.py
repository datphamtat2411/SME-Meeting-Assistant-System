"""Operator-only RabbitMQ 4.1 provisioning/inspection. Never deletes resources.

Uses the existing container's local CLI, not a new management HTTP listener.
Application users are supplied externally; this tool grants no administrator tags.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import subprocess

WORK = "meeting.processing.jobs"
DEAD = WORK + ".dead"
EXCHANGE = "meeting.processing"
DLX = EXCHANGE + ".dlx"
ROUTE = "processing.job.queued"


class Blocked(Exception):
    pass


def definitions(vhost, users):
    args = {"x-queue-type": "quorum", "x-delivery-limit": 5,
            "x-overflow": "reject-publish", "x-dead-letter-exchange": DLX,
            "x-dead-letter-routing-key": DEAD, "x-dead-letter-strategy": "at-least-once"}
    return {
        "vhosts": [{"name": vhost}],
        "exchanges": [{"name": name, "vhost": vhost, "type": "direct", "durable": True,
                       "auto_delete": False, "internal": False, "arguments": {}} for name in (EXCHANGE, DLX)],
        "queues": [{"name": name, "vhost": vhost, "durable": True, "auto_delete": False,
                    "arguments": args if name == WORK else {"x-queue-type": "quorum", "x-delivery-limit": -1}}
                   for name in (WORK, DEAD)],
        "bindings": [{"source": source, "vhost": vhost, "destination": queue,
                      "destination_type": "queue", "routing_key": route, "arguments": {}}
                     for source, queue, route in ((EXCHANGE, WORK, ROUTE), (DLX, DEAD, DEAD))],
        "permissions": [{"user": users[role], "vhost": vhost, "configure": "^$",
                         "write": r"^meeting\.processing$" if role == "publisher" else "^$",
                         "read": {"publisher": "^$", "worker": r"^meeting\.processing\.jobs$",
                                  "reconciler": r"^meeting\.processing\.jobs\.dead$"}[role]}
                        for role in users],
    }


def cli(container, *args):
    return subprocess.check_output(["docker", "exec", container, "rabbitmqctl", *args], text=True, timeout=60)


def inspect(container, vhost):
    queues = json.loads(cli(container, "list_queues", "-p", vhost, "name", "type", "durable", "arguments",
                           "effective_policy_definition", "operator_policy", "policy",
                           "messages", "messages_ready", "messages_unacknowledged", "consumers", "--formatter=json"))
    for queue in queues:
        # rabbitmqctl's Erlang AMQP tables are JSON [key,type,value] triples.
        queue["arguments"] = {key: value for key, _, value in queue["arguments"]}
        if queue["name"] == WORK and queue["type"] == "quorum":
            state = runtime(container, vhost)
            queue["retained_dead_letters"] = state["num_discarded"] + state["num_discard_checked_out"]
    return queues


def runtime(container, vhost):
    """Read only bounded Raft counters/config; never dump pending message bodies."""
    encoded = base64.b64encode(vhost.encode()).decode()
    expression = (
        f'V=base64:decode(<<"{encoded}">>), '
        '{ok,Q}=rabbit_amqqueue:lookup(rabbit_misc:r(V,queue,<<"meeting.processing.jobs">>)), '
        '{ok,{_,M},_}=ra:local_query(amqqueue:get_pid(Q),fun rabbit_fifo:overview/1), '
        '{ok,T}=application:get_env(rabbit,dead_letter_worker_publisher_confirm_timeout), '
        'C=maps:with([dead_letter_handler,overflow_strategy,delivery_limit,dead_lettering_enabled],maps:get(config,M)), '
        'S=maps:with([num_messages,num_discarded,num_discard_checked_out],M), '
        'base64:encode(rabbit_json:encode(S#{config=>C,confirm_timeout_ms=>T,stream_queue_enabled=>rabbit_feature_flags:is_enabled(stream_queue)})).'
    )
    output = cli(container, "eval", expression)
    match = re.fullmatch(r'\s*<<"([A-Za-z0-9+/=]+)">>\s*', output)
    if match is None:
        raise Blocked("BLOCKED: quorum runtime inspection unavailable")
    return json.loads(base64.b64decode(match[1]))


def verify_runtime(state):
    if state["config"] != {"dead_letter_handler": "at_least_once", "overflow_strategy": "reject_publish",
                           "delivery_limit": 5, "dead_lettering_enabled": True} or not state["stream_queue_enabled"]:
        raise Blocked("BLOCKED: effective quorum runtime does not satisfy Worker V1")


def migration_ready(queues):
    for queue in queues:
        # Pending internal dead letters are invisible in ordinary ready/unacked
        # depths. Total messages must also be zero before migration readiness.
        if any(queue.get(field) != 0 for field in ("messages", "messages_ready", "messages_unacknowledged", "consumers")):
            raise Blocked("BLOCKED: queued/unacknowledged work, consumers or incomplete inspection; preserve data")
        if queue.get("name") == WORK and queue.get("type") == "quorum" and queue.get("retained_dead_letters") != 0:
            raise Blocked("BLOCKED: retained internal dead letters or incomplete Raft inspection; preserve data")


def verify(queues):
    expected = definitions("unused", {})["queues"]
    for definition in expected:
        queue = next((q for q in queues if q["name"] == definition["name"]), None)
        if queue is None or queue["type"] != "quorum" or not queue["durable"]:
            raise Blocked("BLOCKED: required durable quorum queue missing/incompatible")
        if any(queue["arguments"].get(k) != v for k, v in definition["arguments"].items()):
            raise Blocked("BLOCKED: Worker V1 queue arguments differ")
        # Fail closed on policy overlays; an operator must explicitly reconcile them.
        if queue.get("operator_policy") or queue.get("effective_policy_definition"):
            raise Blocked("BLOCKED: policy overlay requires review against explicit queue arguments")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "migration-ready", "accounts", "provision", "verify"))
    parser.add_argument("--container", required=True)
    parser.add_argument("--vhost", required=True)
    for role in ("publisher", "worker", "reconciler"):
        parser.add_argument("--" + role + "-user")
    args = parser.parse_args()
    queues = inspect(args.container, args.vhost)
    selected = [q for q in queues if q["name"] in (WORK, DEAD)]
    print(json.dumps(selected, indent=2))  # bounded resource metadata only; no messages/secrets
    if args.action == "migration-ready":
        if len(selected) != 2:
            raise Blocked("BLOCKED: both queues must be inspected")
        migration_ready(selected)
        print("QUEUE-READY: additionally verify all replicas/intake/publishers paused and DB evidence recorded")
    elif args.action == "verify":
        verify(queues)
        state = runtime(args.container, args.vhost)
        verify_runtime(state)
        print(json.dumps(state, indent=2))
        bindings = json.loads(cli(args.container, "list_bindings", "-p", args.vhost,
                                 "source_name", "destination_name", "routing_key", "--formatter=json"))
        for source, target, route in ((EXCHANGE, WORK, ROUTE), (DLX, DEAD, DEAD)):
            if not any(b["source_name"] == source and b["destination_name"] == target
                       and b["routing_key"] == route for b in bindings):
                raise Blocked("BLOCKED: required binding missing")
        print(cli(args.container, "list_policies", "-p", args.vhost, "--formatter=json"))
        print("PASS: declared quorum arguments and bindings; inspect operator policies for overrides")
    elif args.action in ("provision", "accounts"):
        if any(q["type"] != "quorum" for q in selected):
            raise Blocked("BLOCKED: classic queues require controlled migration; nothing deleted")
        users = {role: getattr(args, role + "_user") for role in ("publisher", "worker", "reconciler")}
        if not all(users.values()) or len(set(users.values())) != 3:
            raise Blocked("BLOCKED: three distinct application user names required")
        document = definitions(args.vhost, users)
        if args.action == "accounts":
            existing = json.loads(cli(args.container, "list_users", "--formatter=json"))
            if any(user["user"] in users.values() for user in existing):
                raise Blocked("BLOCKED: application user already exists; no credentials rotated")
            accounts = []
            for role, user in users.items():
                password = os.environ.get("BROKER_" + role.upper() + "_PASSWORD", "")
                if len(password) < 16:
                    raise Blocked("BLOCKED: separate external application passwords (>=16 chars) required")
                salt = secrets.token_bytes(4)
                digest = base64.b64encode(salt + hashlib.sha256(salt + password.encode()).digest()).decode()
                accounts.append({"name": user, "password_hash": digest,
                                 "hashing_algorithm": "rabbit_password_hashing_sha256", "tags": []})
            document = {"users": accounts}
        encoded = base64.b64encode(json.dumps(document).encode()).decode()
        if cli(args.container, "eval", f'rabbit_definitions:import_raw(base64:decode(<<"{encoded}">>)).').strip() != "ok":
            raise Blocked("BLOCKED: definition import failed; inspect broker resource metadata")
        if args.action == "provision":
            verify(inspect(args.container, args.vhost))


if __name__ == "__main__":
    try:
        main()
    except Blocked as error:
        raise SystemExit(str(error)) from None
