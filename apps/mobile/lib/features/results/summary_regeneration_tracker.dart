import '../recording/media_contracts.dart';

/// Tracks only the admitted regeneration job. A job disappearing from a
/// refresh or an unrelated job completing is not a terminal result.
class SummaryRegenerationTracker {
  String? _jobId;
  ProcessingJobRecord? _job;
  bool _admitting = false;
  bool _admissionRejected = false;

  String? get jobId => _jobId;
  ProcessingJobRecord? get job => _job;
  bool get admitting => _admitting;
  bool get admissionRejected => _admissionRejected;
  String? get pendingJobId => _job?.status.isTerminal == true ? null : _jobId;

  void begin() {
    _admitting = true;
    _admissionRejected = false;
    _jobId = null;
    _job = null;
  }

  void admit(String id) {
    _admitting = false;
    _admissionRejected = false;
    _jobId = id;
    _job = null;
  }

  void fail({required bool uncertain}) {
    _admitting = false;
    _admissionRejected = !uncertain;
  }

  bool observe(ProcessingJobRecord candidate) {
    if (candidate.id != _jobId ||
        candidate.jobType != ProcessingJobType.derivedStageProcessing) {
      return false;
    }
    final previous = _job;
    if (previous != null &&
        (candidate.retryCount < previous.retryCount ||
            (candidate.retryCount == previous.retryCount &&
                (candidate.updatedAt.isBefore(previous.updatedAt) ||
                    previous.status.isTerminal &&
                        !candidate.status.isTerminal)))) {
      return false;
    }
    if (previous != null &&
        previous.status == candidate.status &&
        previous.retryCount == candidate.retryCount &&
        previous.updatedAt == candidate.updatedAt) {
      return false;
    }
    _job = candidate;
    return true;
  }

  void clear() {
    _jobId = null;
    _job = null;
    _admitting = false;
    _admissionRejected = false;
  }
}
