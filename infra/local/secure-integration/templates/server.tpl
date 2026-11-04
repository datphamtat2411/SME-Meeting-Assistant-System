{
  "subject": {{ toJson .Subject }},
  "sans": {{ toJson .SANs }},
  "keyUsage": ["digitalSignature", "keyEncipherment"],
  "extKeyUsage": ["serverAuth"]
}
