"""Opt-in sanitized campaign ledger, including teardown and overall test outcome."""

import os
from pathlib import Path


class CampaignLedger:
    def __init__(self, destination):
        self.destination = Path(destination)
        self.reports = []

    def append(self, text):
        with self.destination.open("a", encoding="utf-8") as ledger:
            ledger.write(text)

    def pytest_sessionstart(self, session):
        self.append("\n## V6.2.2 focused command — actual execution\n\n"
                    "Per-test outcomes include teardown; inference is deterministic; paid requests=0.\n\n")

    def pytest_runtest_logreport(self, report):
        self.reports.append((report.nodeid, report.when, report.outcome))
        if report.when == "call" or report.outcome != "passed":
            self.append(f"- `{report.nodeid}` ({report.when}): **{report.outcome.upper()}**\n")

    def pytest_sessionfinish(self, session, exitstatus):
        calls = [outcome for _, phase, outcome in self.reports if phase == "call"]
        problems = [item for item in self.reports if item[2] != "passed"]
        verdict = "PASS" if int(exitstatus) == 0 and not problems else "FAIL / INCOMPLETE"
        self.append(f"\nFocused command verdict: **{verdict}**; pytest exit={int(exitstatus)}; "
                    f"passed calls={calls.count('passed')}; failed calls={calls.count('failed')}; "
                    f"skips={sum(outcome == 'skipped' for _, _, outcome in self.reports)}.\n"
                    "Real-provider smoke/Core E2E: **BLOCKED — REAL-PROVIDER AUTHORIZATION REQUIRED**.\n"
                    "**V6.2.2 DEFAULT PROMOTION — AWAITING APPROVAL**; default remains `v5_full`.\n")
        required = (
            "test_environment_selected_v62_edit_contracts[empty]",
            "test_environment_selected_v62_edit_contracts[noop]",
            "test_environment_selected_v62_edit_contracts[sparse]",
            "test_v62_core_fixture_matches_production_composition",
            "test_v622_java_worker_compatibility",
            "test_real_v622_core_acceptance_with_production_composition[sparse]",
            "test_real_v622_core_acceptance_with_production_composition[empty]",
            "test_real_core_to_worker_level_a_acceptance",
        )
        passed = {node.rsplit("::", 1)[-1] for node, phase, outcome in self.reports
                  if phase == "call" and outcome == "passed"}
        if verdict == "PASS" and set(required) <= passed:
            self.append("\n**V6.2.2 OFFLINE CORE INTEGRATION VERIFIED** — production composition, "
                        "environment selection, sparse/no-op contracts, current Python-generated Java fixture, "
                        "Java historical/negative compatibility, two real Core cases and no-fault Level A passed. "
                        "Per-test teardown passed; provider-origin acceptance is still blocked.\n")


def pytest_configure(config):
    if destination := os.environ.get("V622_ACCEPTANCE_LEDGER"):
        # Global registration is required: this campaign includes tests outside
        # this conftest's directory. Capture the path before offline env isolation.
        config.pluginmanager.register(CampaignLedger(destination), "v622-campaign-ledger")
