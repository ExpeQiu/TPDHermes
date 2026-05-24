"""KB collection re-embed。"""

from unittest.mock import MagicMock, patch

from backend.services.kb_reembed import reembed_chroma_collection


@patch("backend.services.kb_reembed.kb_proxy_service")
@patch("backend.services.kb_reembed.embed_texts_sync")
@patch("backend.services.kb_reembed.ChromaHttpClient")
def test_reembed_upserts_batches(MockClient, mock_embed, _proxy):
    cli = MagicMock()
    MockClient.return_value = cli
    cli.heartbeat.return_value = True
    cli.get_by_where.return_value = {
        "ids": ["c1", "c2"],
        "documents": ["doc a", "doc b"],
        "metadatas": [{}, {}],
    }
    mock_embed.return_value = [[0.1], [0.2]]

    report = reembed_chroma_collection(
        chroma_url="http://c",
        collection="public.test",
        batch_size=64,
        dry_run=False,
    )

    assert report["chunks_reembedded"] == 2
    assert report["status"] == "completed"
    cli.ensure_collection.assert_called_once()
    cli.upsert.assert_called_once()
    _proxy.clear_caches.assert_called_once()
    assert cli.upsert.call_args.kwargs.get("embeddings") is not None


@patch("backend.services.kb_reembed.ChromaHttpClient")
def test_reembed_dry_run_no_upsert(MockClient):
    cli = MagicMock()
    MockClient.return_value = cli
    cli.heartbeat.return_value = True
    cli.get_by_where.return_value = {
        "ids": ["c1"],
        "documents": ["x"],
        "metadatas": [{}],
    }

    report = reembed_chroma_collection(
        chroma_url="http://c",
        collection="col",
        dry_run=True,
    )
    assert report["chunks_reembedded"] == 1
    cli.upsert.assert_not_called()
