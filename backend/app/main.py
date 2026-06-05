from fastapi import FastAPI
from dotenv import load_dotenv

from backend.app.api.routes import router as api_router
from core.control.logging_config import configure_file_logging

load_dotenv()
configure_file_logging("backend/app/backend.log")

app = FastAPI(title="Licenta Backend", version="0.1.0")
app.include_router(api_router, prefix="/api")
