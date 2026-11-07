"""Operator-only RustFS IAM setup. Secrets come from external environment, never CLI.

No deletion/rotation: refuses existing users. Application clients do not import this.
The Nginx storage boundary supplies the conditional-write rule missing in RustFS 1.0.3.
"""
import argparse
import hashlib
import json
import os
import re
import ssl
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

from botocore.auth import SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.credentials import Credentials


def policy(bucket, role):
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ValueError("Invalid bucket")
    prefix = f"arn:aws:s3:::{bucket}/"
    source = prefix + "meetings/*/sources/*"
    result = prefix + "processing/*/transcription/results/*.json"
    diarization = prefix + "processing/*/diarization/results/*.json"
    statements = [
        {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [source,
            diarization if role == "diarization-worker" else result]},
    ]
    if role == "worker":
        statements.append({"Effect": "Allow", "Action": ["s3:PutObject"], "Resource": [result]})
    elif role == "diarization-worker":
        statements.append({"Effect": "Allow", "Action": ["s3:PutObject"], "Resource": [diarization]})
    elif role == "core":
        pending = prefix + "meetings/*/pending/*"
        intelligence = prefix + "processing/*/intelligence/*"
        statements.extend([
            {"Effect": "Allow", "Action": ["s3:GetObject"], "Resource": [diarization]},
            {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject"], "Resource": [pending, source, intelligence]},
            {"Effect": "Allow", "Action": ["s3:DeleteObject"], "Resource": [pending, intelligence]},
            {"Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": [prefix[:-1]],
             "Condition": {"StringLike": {"s3:prefix": ["processing/*/intelligence/"]}}},
        ])
    else:
        raise ValueError("Unknown storage role")
    return {"Version": "2012-10-17", "Statement": statements}


class Admin:
    def __init__(self, endpoint, ca, access, secret):
        parsed = urlsplit(endpoint)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.query or parsed.path not in ("", "/"):
            raise ValueError("Verified HTTPS storage endpoint required")
        self.endpoint = endpoint.rstrip("/")
        self.context = ssl.create_default_context(cafile=str(ca))
        self.credentials = Credentials(access, secret)

    def request(self, method, operation, query=None, body=None):
        url = self.endpoint + "/rustfs/admin/v3/" + operation
        if query:
            url += "?" + urlencode(query)
        data = json.dumps(body).encode() if body is not None else b""
        request = AWSRequest(method=method, url=url, data=data, headers={"Content-Type": "application/json",
            "x-amz-content-sha256": hashlib.sha256(data).hexdigest()})
        SigV4Auth(self.credentials, "s3", "us-east-1").add_auth(request)
        prepared = request.prepare()
        try:
            with urlopen(Request(prepared.url, data=data if method != "GET" else None,
                                 headers=dict(prepared.headers), method=method), context=self.context, timeout=15) as response:
                return response.status
        except HTTPError as error:
            # Do not expose server response bodies, keys or signatures.
            return error.code

    def provision(self, bucket, role, user, secret):
        if self.request("GET", "user-info", {"accessKey": user}) != 404:
            raise RuntimeError("BLOCKED: existing/uninspectable user; no credentials changed")
        name = "worker-v1-" + role
        for operation, query, body in (
            ("add-canned-policy", {"name": name}, policy(bucket, role)),
            ("add-user", {"accessKey": user}, {"secretKey": secret, "status": "enabled"}),
            ("set-user-or-group-policy", {"policyName": name, "userOrGroup": user, "isGroup": "false"}, None),
        ):
            if self.request("PUT", operation, query, body) != 200:
                raise RuntimeError("BLOCKED: storage IAM provisioning incomplete; inspect operator state")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("policy", "provision"))
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--role", choices=("worker", "diarization-worker", "core"), required=True)
    args = parser.parse_args()
    if args.action == "policy":
        print(json.dumps(policy(args.bucket, args.role), indent=2))
    else:
        admin = Admin(os.environ["STORAGE_ADMIN_ENDPOINT"], os.environ["STORAGE_ADMIN_CA_FILE"],
                      os.environ["STORAGE_ADMIN_ACCESS_KEY"], os.environ["STORAGE_ADMIN_SECRET_KEY"])
        admin.provision(args.bucket, args.role, os.environ["STORAGE_NEW_USER"], os.environ["STORAGE_NEW_SECRET"])
        print("PASS: separate IAM identity provisioned; verify workload permissions and boundary before activation")


if __name__ == "__main__":
    main()
