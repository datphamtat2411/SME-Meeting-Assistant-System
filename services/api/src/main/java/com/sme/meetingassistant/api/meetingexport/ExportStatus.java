package com.sme.meetingassistant.api.meetingexport;

/** Persistent export lifecycle; freshness is deliberately orthogonal. */
public enum ExportStatus {
    PENDING, GENERATING, READY, FAILED
}
