class ScannerConfig:
    def __init__(self, name, historical_filters, realtime_filters):
        self.name = name
        self.historical_filters = historical_filters
        self.realtime_filters = realtime_filters