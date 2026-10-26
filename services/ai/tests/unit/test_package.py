from importlib.metadata import distribution

import sme_meeting_ai


def test_package_is_importable_and_installed():
    assert sme_meeting_ai.__name__ == "sme_meeting_ai"
    assert distribution("sme-meeting-ai").metadata["Name"] == "sme-meeting-ai"


def test_independent_console_scripts_are_installed():
    scripts = {
        entry.name: entry.value
        for entry in distribution("sme-meeting-ai").entry_points
        if entry.group == "console_scripts"
    }
    assert scripts == {
        "sme-ai-http": "sme_meeting_ai.api.__main__:main",
        "sme-ai-worker": "sme_meeting_ai.workers.__main__:main",
    }
