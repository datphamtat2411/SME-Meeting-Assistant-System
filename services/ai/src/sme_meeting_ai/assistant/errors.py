"""Sanitized Assistant capability errors."""


class AssistantProviderError(RuntimeError):
    """Provider failure carrying only an allowlisted category."""

    def __init__(self, category: str, *, retryable: bool = False):
        self.category = category
        self.retryable = retryable
        super().__init__(category)


class FinalVerificationError(RuntimeError):
    """The final trusted authorization/source check did not pass."""

    def __init__(self, category: str):
        self.category = category
        super().__init__(category)


__all__ = ["AssistantProviderError", "FinalVerificationError"]
