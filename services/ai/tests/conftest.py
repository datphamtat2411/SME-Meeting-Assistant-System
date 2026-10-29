import pytest
from tls_support import create_test_pki


@pytest.fixture(scope="session")
def test_pki(tmp_path_factory):
    return create_test_pki(tmp_path_factory.mktemp("test-pki"))
