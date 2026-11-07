package com.sme.meetingassistant.api.media.diarization;

import com.sme.meetingassistant.api.diarization.contract.DiarizationResultContract.ValidatedResult;

/** Transcript-owned canonical speaker projection integration port.
 * Called inside the acceptance transaction with Meeting/Job locks and live revision fencing.
 * Must persist the canonical speaker projection or throw; never perform network I/O here.
 */
public interface DiarizationSpeakerProjection {
    void project(ValidatedResult result);
}
