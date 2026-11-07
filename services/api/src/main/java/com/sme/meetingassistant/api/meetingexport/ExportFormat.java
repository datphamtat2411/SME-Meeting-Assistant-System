package com.sme.meetingassistant.api.meetingexport;

/** Exactly the two canonical RE05 persisted file types. */
public enum ExportFormat {
    MARKDOWN("md"), PDF("pdf");

    private final String extension;

    ExportFormat(String extension) { this.extension = extension; }

    public String extension() { return extension; }
}
