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
DIARIZATION_WORK = "meeting.processing.diarization"
DIARIZATION_DEAD = DIARIZATION_WORK + ".dead"
DIARIZATION_ROUTE = "processing.diarization.requested"
INTELLIGENCE_WORK = "meeting.processing.intelligence"
INTELLIGENCE_DEAD = INTELLIGENCE_WORK + ".dead"
INTELLIGENCE_ROUTE = "processing.intelligence.requested"
KNOWLEDGE_WORK = "meeting.knowledge.indexing"
KNOWLEDGE_DEAD = KNOWLEDGE_WORK + ".dead"
KNOWLEDGE_ROUTE = "knowledge.indexing.requested"


class Blocked(Exception):
    pass


def definitions(vhost, users, *, diarization=False, intelligence=False, knowledge=False):
    args = {"x-queue-type": "quorum", "x-delivery-limit": 5,
            "x-overflow": "reject-publish", "x-dead-letter-exchange": DLX,
            "x-dead-letter-routing-key": DEAD, "x-dead-letter-strategy": "at-least-once"}
    work = (WORK, DIARIZATION_WORK) if diarization else (WORK,)
    dead = (DEAD, DIARIZATION_DEAD) if diarization else (DEAD,)
    routes = (ROUTE, DIARIZATION_ROUTE) if diarization else (ROUTE,)
    if intelligence:
        work += (INTELLIGENCE_WORK,)
        dead += (INTELLIGENCE_DEAD,)
        routes += (INTELLIGENCE_ROUTE,)
    if knowledge:
        work += (KNOWLEDGE_WORK,)
        dead += (KNOWLEDGE_DEAD,)
        routes += (KNOWLEDGE_ROUTE,)
    return {
        "vhosts": [{"name": vhost}],
        "exchanges": [{"name": name, "vhost": vhost, "type": "direct", "durable": True,
                       "auto_delete": False, "internal": False, "arguments": {}} for name in (EXCHANGE, DLX)],
        "queues": [{"name": name, "vhost": vhost, "durable": True, "auto_delete": False,
                    "arguments": {**args, "x-dead-letter-routing-key": target} if name in work
                    else {"x-queue-type": "quorum", "x-delivery-limit": -1}}
                   for name, target in (*zip(work, dead), *zip(dead, dead))],
        "bindings": [{"source": source, "vhost": vhost, "destination": queue,
                      "destination_type": "queue", "routing_key": route, "arguments": {}}
                     for source, queue, route in (
                         *((EXCHANGE, queue, route) for queue, route in zip(work, routes)),
                         *((DLX, queue, queue) for queue in dead))],
        "permissions": [{"user": users[role], "vhost": vhost, "configure": "^$",
                         "write": r"^meeting\.processing$" if role == "publisher" else "^$",
                           "read": {"publisher": "^$", "worker": (r"^meeting\.processing\.(jobs|diarization)$" if diarization else r"^meeting\.processing\.jobs$"),
                                     "intelligence": r"^meeting\.processing\.intelligence$",
                                     "knowledge": r"^meeting\.knowledge\.indexing$",
                                     "reconciler": "^(?:" + "|".join(re.escape(q) for q in dead) + ")$"}[role]}
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
        if queue["name"] in (WORK, DIARIZATION_WORK, INTELLIGENCE_WORK, KNOWLEDGE_WORK) and queue["type"] == "quorum":
            state = runtime(container, vhost, queue["name"])
            queue["retained_dead_letters"] = state["num_discarded"] + state["num_discard_checked_out"]
    return queues


def runtime(container, vhost, queue=WORK):
    """Read only bounded Raft counters/config; never dump pending message bodies."""
    encoded = base64.b64encode(vhost.encode()).decode()
    if queue not in (WORK, DIARIZATION_WORK, INTELLIGENCE_WORK, KNOWLEDGE_WORK):
        raise Blocked("BLOCKED: unknown worker queue")
    expression = (
        f'V=base64:decode(<<"{encoded}">>), '
        f'{{ok,Q}}=rabbit_amqqueue:lookup(rabbit_misc:r(V,queue,<<"{queue}">>)), '
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
        if queue.get("name") in (WORK, DIARIZATION_WORK, INTELLIGENCE_WORK, KNOWLEDGE_WORK) and queue.get("type") == "quorum" and queue.get("retained_dead_letters") != 0:
            raise Blocked("BLOCKED: retained internal dead letters or incomplete Raft inspection; preserve data")


def verify(queues, *, diarization=False, intelligence=False, knowledge=False):
    expected = definitions("unused", {}, diarization=diarization, intelligence=intelligence,
                           knowledge=knowledge)["queues"]
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
    parser.add_argument("--diarization", action="store_true", help="Include the independent diarization quorum route and grants")
    parser.add_argument("--intelligence", action="store_true", help="Include the dedicated Meeting Intelligence route and separate consumer account")
    parser.add_argument("--knowledge", action="store_true", help="Include the dedicated knowledge-indexing route and separate consumer account")
    parser.add_argument("--intelligence-user")
    parser.add_argument("--knowledge-user")
    for role in ("publisher", "worker", "reconciler"):
        parser.add_argument("--" + role + "-user")
    args = parser.parse_args()
    queues = inspect(args.container, args.vhost)
    names = (WORK, DEAD, DIARIZATION_WORK, DIARIZATION_DEAD) if args.diarization else (WORK, DEAD)
    if args.intelligence:
        names += (INTELLIGENCE_WORK, INTELLIGENCE_DEAD)
    if args.knowledge:
        names += (KNOWLEDGE_WORK, KNOWLEDGE_DEAD)
    selected = [q for q in queues if q["name"] in names]
    print(json.dumps(selected, indent=2))  # bounded resource metadata only; no messages/secrets
    if args.action == "migration-ready":
        if len(selected) != len(names):
            raise Blocked("BLOCKED: every selected queue must be inspected")
        migration_ready(selected)
        print("QUEUE-READY: additionally verify all replicas/intake/publishers paused and DB evidence recorded")
    elif args.action == "verify":
        verify(queues, diarization=args.diarization, intelligence=args.intelligence,
               knowledge=args.knowledge)
        work = (WORK, DIARIZATION_WORK) if args.diarization else (WORK,)
        if args.intelligence:
            work += (INTELLIGENCE_WORK,)
        if args.knowledge:
            work += (KNOWLEDGE_WORK,)
        for queue in work:
            state = runtime(args.container, args.vhost, queue)
            verify_runtime(state)
            print(json.dumps(state, indent=2))
        bindings = json.loads(cli(args.container, "list_bindings", "-p", args.vhost,
                                 "source_name", "destination_name", "routing_key", "--formatter=json"))
        for binding in definitions(args.vhost, {}, diarization=args.diarization,
                                   intelligence=args.intelligence, knowledge=args.knowledge)["bindings"]:
            source, target, route = binding["source"], binding["destination"], binding["routing_key"]
            if not any(b["source_name"] == source and b["destination_name"] == target
                       and b["routing_key"] == route for b in bindings):
                raise Blocked("BLOCKED: required binding missing")
        print(cli(args.container, "list_policies", "-p", args.vhost, "--formatter=json"))
        print("PASS: declared quorum arguments and bindings; inspect operator policies for overrides")
    elif args.action in ("provision", "accounts"):
        if any(q["type"] != "quorum" for q in selected):
            raise Blocked("BLOCKED: classic queues require controlled migration; nothing deleted")
        users = {role: getattr(args, role + "_user") for role in ("publisher", "worker", "reconciler")}
        if args.intelligence:
            users["intelligence"] = args.intelligence_user
        if args.knowledge:
            users["knowledge"] = args.knowledge_user
        if not all(users.values()) or len(set(users.values())) != len(users):
            raise Blocked("BLOCKED: distinct application user names required for every selected role")
        document = definitions(args.vhost, users, diarization=args.diarization,
                               intelligence=args.intelligence, knowledge=args.knowledge)
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
            verify(inspect(args.container, args.vhost), diarization=args.diarization,
                   intelligence=args.intelligence, knowledge=args.knowledge)


if __name__ == "__main__":
    try:
        main()
    except Blocked as error:
        raise SystemExit(str(error)) from None
