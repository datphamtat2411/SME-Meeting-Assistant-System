package com.sme.meetingassistant.api.actionitems.application;

import com.sme.meetingassistant.api.actionitems.ActionItemView;
import com.sme.meetingassistant.api.actionitems.dto.ActionItemProposal;

/** Application boundary used by trusted extraction adapters to submit derived proposals. */
public interface ActionItemProposalPort {
    ActionItemView propose(ActionItemProposal proposal);
}
