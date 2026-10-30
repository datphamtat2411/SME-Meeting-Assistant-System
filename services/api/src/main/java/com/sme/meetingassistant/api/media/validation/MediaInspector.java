package com.sme.meetingassistant.api.media.validation;

import java.nio.file.Path;

public interface MediaInspector {
    MediaInspection inspect(Path mediaFile);
}
