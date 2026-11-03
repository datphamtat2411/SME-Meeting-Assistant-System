"""Experimental recall/phrase-policy prompt, still one strict-schema completion."""

from collections.abc import Mapping

from sme_meeting_ai.core.config import Settings

from .correction_v6_generation import (
    V6CorrectionProvider,
    V6CorrectionRequest,
    V6GenerationOutcome,
    _generate_span_proposal,
    _validate_span_request,
)
from .correction_v61_generation import V61_SYSTEM_PROMPT
from .reconciliation import TranscriptReconciliation

V62_PROMPT_VERSION = "vi-whole-meeting-6.2.2"
_COLLOCATION_REVIEW = """RÀ SOÁT CỤM TỪ TIẾNG VIỆT — ƯU TIÊN TRƯỚC KHI LẬP EDIT
Đọc các kết hợp từ ngắn trong câu, không chỉ kiểm tra từng tiếng riêng lẻ.
Từng từ có nghĩa trong từ điển không bảo đảm cả cụm có nghĩa trong lời đang nói.
Rà soát đặc biệt động từ kèm kết quả/trạng thái, cụm danh từ, thành ngữ và cách
gọi người trong khẩu ngữ. Một tổ hợp khó giải thích theo cả câu là ứng viên cần
kiểm tra, kể cả khi ASR không tạo ra từ sai chính tả.

Với mỗi cụm đáng ngờ, so sánh nội bộ vài cách đọc gần âm: phụ âm đầu, vần,
nguyên âm và dấu thanh; xét cả các nhầm lẫn d/gi/r, ch/tr, s/x, l/n. Đánh giá
nghĩa của TOÀN CỤM theo câu và câu chuyện. Trong các cách đọc phù hợp, ưu tiên
ứng viên ít thay đổi âm/chữ nhất, giữ đúng hành động và kết quả đang được kể.
Đừng chọn một từ mô tả sự kiện khác chỉ vì nó cũng hợp chủ đề hoặc làm câu trôi
chảy hơn. Ngữ cảnh giúp chọn cách đọc của lời nói, không phải viết lại sự kiện.

Sửa từng chỗ có căn cứ độc lập. Nếu một tiếng có thể sửa rõ ràng còn phần bên
cạnh chưa chắc, hãy đề xuất edit nhỏ cho tiếng đó; đừng bỏ qua cả cụm. Không gộp
các lỗi riêng thành một thay thế dài. Trước khi trả JSON, đọc lại riêng các cụm
vẫn giữ nguyên: đã bỏ sót một thay đổi phụ âm hoặc dấu thanh nhỏ tạo thành cách
nói quen thuộc, đúng nghĩa trong ngữ cảnh hay chưa? Giữ tên riêng, phương ngữ,
tiếng lóng và cách nói lạ nhưng có căn cứ; không ép sửa chỉ vì ít gặp.
Toàn bộ rà soát diễn ra trong cùng một completion; chỉ trả schema edit bên dưới.

"""
_OLD_BOUNDARIES = """Boundary changes are exceptional: at most four source tokens,
two or three target tokens, one split/merge and an unchanged anchor. Preserve the
concatenated spelling; a contraction may instead remove at most one epenthetic
vowel or duplicated letter within the merged pair, never a spoken word. The exact
complete target phrase with its anchor must already occur in another original
segment. Without that evidence, preserve the source. No speculative contraction."""
_NEW_BOUNDARIES = """A short aligned repair may contain up to four source and four target tokens,
with at most two independently near-phonetic lexical changes. Prefer the smallest
independently supported edit, not several unrelated errors in one large span.
An obvious missing/extra vowel may be repaired when onset and ending are retained.
An exceptional contraction may merge one adjacent pair in three/four original
tokens into two/three target tokens, with every other word an unchanged anchor.
An exact second occurrence is not required for a literal orthographic merge, a
bounded epenthetic-vowel repair retaining consonants and word edges, or a distorted
duplicate syllable pair whose merged term matches each syllable. Never simply
delete an original repeated word or change an unrelated neighboring word to make
the contraction work. Conversational context must support the spoken wording;
do not add a more specific subtype or qualifier merely because it fits the topic."""
V62_SYSTEM_PROMPT = _COLLOCATION_REVIEW + V61_SYSTEM_PROMPT.replace(_OLD_BOUNDARIES, _NEW_BOUNDARIES) + """

RECALL AND OCCURRENCE AUDIT — WITHIN THE SAME ONE COMPLETION
Treat an implausible local collocation as a concrete repair candidate even when
its individual words are valid. Compare minimal onset, vowel, ending and tone
alternatives, then use local and whole-meeting context to select supported wording.
Do not preserve an obvious near-spoken error merely because it could be a word in
some unrelated context. Preserve genuinely unresolved alternatives.
For every supported recurring term, revisit every occurrence in the ORIGINAL
input, including different surrounding verbs, clauses and segment positions.
For each unchanged occurrence, distinguish a legitimate different meaning from a
missed repair. Emit an independently anchored edit for each supported same-referent
occurrence; do not infer that correcting the title also corrected later mentions.
Count exact source occurrences before assigning zero-based indexes. Keep separate
errors separate so one doubtful repair cannot suppress an unrelated supported one.
Perform the final omission audit after the edit list is complete. Return only the
unchanged four-field sparse JSON schema, with no audit or reasoning in the output.

CONTEXT-FIRST SHORT-PHRASE REVIEW
Context takes priority over a poor individual-syllable match when the ORIGINAL
context strongly establishes the intended short expression. The ordinary
per-syllable near-match requirement is not an absolute veto on this contextual
path. In a clear injury narrative, review a garbled short anatomical expression
jointly using the unchanged injury action and independent surrounding injury
events. One badly recognized component may be recovered when the rest retains
lexical traces and the original conversation supports the complete collocation.
Compare the whole-meeting topic with the local sentence so an earlier medical
discussion cannot override a later unrelated topic. Prefer the least specific
supported term; never add a subtype, side, severity or other detail not established
by the original speech. Do not replace an already meaningful anatomical term with
another merely because it is plausible. Preserve names, numbers, negation, fillers
and genuine repetition. Return a minimal independent proposal, not a rewrite of
the explanation or a claim of acoustic verification.
"""


def _validate_v62_request(request: V6CorrectionRequest, config: Mapping) -> int:
    return _validate_span_request(request, config, system_prompt=V62_SYSTEM_PROMPT)


def generate_v62_proposal(
    reconciliation: TranscriptReconciliation, provider: V6CorrectionProvider, settings: Settings,
) -> V6GenerationOutcome:
    return _generate_span_proposal(
        reconciliation, provider, settings, system_prompt=V62_SYSTEM_PROMPT,
        prompt_version=V62_PROMPT_VERSION, validate_request=_validate_v62_request,
    )
