from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.routes import projects_router
from backend.routes.kb import router as kb_router
from backend.routes.kb_sse import router as kb_sse_router
from backend.routes.workshop import router as workshop_router
from backend.routes.skills_store import router as skills_store_router
from backend.routes.feishu import router as feishu_router
from backend.routes.feishu_bot import router as feishu_bot_router

app = FastAPI(title="TPDHermes API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(projects_router)
app.include_router(kb_router)
app.include_router(kb_sse_router)    # M2-T03: KB SSE
app.include_router(workshop_router)
app.include_router(skills_store_router)
app.include_router(feishu_router)
app.include_router(feishu_bot_router)  # M6-T05: /hermes bot


@app.get("/")
async def root():
    return {"message": "TPDHermes API", "status": "running"}


@app.get("/health")
async def health():
    return {"status": "healthy"}
