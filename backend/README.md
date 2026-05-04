# Backend Scaffold

## Run locally

```bash
cd ..
python -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
pip install -e .
uvicorn backend.app.main:app --reload
```
