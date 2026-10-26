from importlib.metadata import distribution

import sme_meeting_ai


def test_package_is_importable_and_installed():
    assert sme_meeting_ai.__name__ == "sme_meeting_ai"
    assert distribution("sme-meeting-ai").metadata["Name"] == "sme-meeting-ai"
