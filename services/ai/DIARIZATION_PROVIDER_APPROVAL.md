# Diarization provider data handling

Replicate diarization uploads source audio to an external provider and retrieves
provider-generated diarization output. Set `AI_DIARIZATION_ENABLED=false` to
disable this inference independently of other AI components. The adapter accepts
nonempty regular files up to 100,000,000 bytes; model compatibility with compressed
formats has not been verified and filename extensions do not establish validity.

Before production enablement, obtain evidence and approval under the project's
existing security requirements for audio transfer, input and output retention and
deletion, provider and subprocessors' logging, training or other secondary use,
and applicable regional, contractual, and organizational compliance constraints.
The provider's current retention, logging, and secondary-use policies have not been
verified here; this document does not constitute privacy or security approval.
