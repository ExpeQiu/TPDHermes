"""退出码与异常（对齐 CLI 标准）。"""

EXIT_OK = 0
EXIT_ERROR = 1
EXIT_NO_DATA = 2
EXIT_EXEC_FAIL = 3
EXIT_INTERRUPT = 130


class MultiAgentError(Exception):
    """通用错误 → exit 1。"""

    exit_code = EXIT_ERROR


class NoDeliveryError(MultiAgentError):
    """无有效交付 → exit 2。"""

    exit_code = EXIT_NO_DATA


class ExecFailError(MultiAgentError):
    """模式执行失败 → exit 3。"""

    exit_code = EXIT_EXEC_FAIL
