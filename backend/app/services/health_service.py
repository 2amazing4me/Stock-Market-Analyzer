from backend.app.schemas.health import HealthResponse


def build_health_payload(request_id: str) -> HealthResponse:
    return HealthResponse(status="ok", request_id=request_id)
