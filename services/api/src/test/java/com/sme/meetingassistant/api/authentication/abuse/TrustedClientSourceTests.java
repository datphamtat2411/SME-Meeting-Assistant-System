package com.sme.meetingassistant.api.authentication.abuse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class TrustedClientSourceTests {
    private MockHttpServletRequest request(String remote,String forwarded) {
        var request=new MockHttpServletRequest();
        request.setRemoteAddr(remote);
        if (forwarded!=null) request.addHeader("X-Forwarded-For",forwarded);
        return request;
    }

    @Test void untrustedPeerCannotSpoofIdentityUsingForwardingHeaders() {
        var source=new TrustedClientSource("10.2.0.1,10.2.0.2");
        assertThat(source.from(request("198.51.100.100","203.0.113.50")))
            .isEqualTo("198.51.100.100");
        assertThat(source.from(request("127.0.0.1","203.0.113.50")))
            .isEqualTo("127.0.0.1");
    }

    @Test void trustedChainWalksRightToFirstUntrustedPeer() {
        var source=new TrustedClientSource("10.2.0.1,10.2.0.2");
        assertThat(source.from(request("10.2.0.1",
            "192.0.2.1, 203.0.113.7, 10.2.0.2"))).isEqualTo("203.0.113.7");
        assertThat(source.from(request("10.2.0.1","10.2.0.2"))).isEqualTo("10.2.0.1");
    }

    @Test void malformedProxyChainFailsBackToSocketPeer() {
        var source=new TrustedClientSource("10.2.0.1");
        assertThat(source.from(request("10.2.0.1","hello.example"))).isEqualTo("10.2.0.1");
        assertThat(source.from(request("10.2.0.1","1.2.3.4, injection\r\nX-Test: yep")))
            .isEqualTo("10.2.0.1");
        assertThatThrownBy(()->new TrustedClientSource("trusted.example"))
            .isInstanceOf(IllegalArgumentException.class);
    }
}
