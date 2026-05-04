class Filter:
    def apply(self, symbol: str, context: dict) -> bool:
        raise NotImplementedError