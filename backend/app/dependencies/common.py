from uuid import uuid4


def get_request_id() -> str:
    return str(uuid4())
