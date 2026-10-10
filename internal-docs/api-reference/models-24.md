# Server API models 24

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## PhotographyWorkflowConfigDto


```json
{
  "additionalProperties": false,
  "properties": {
    "config": {
      "additionalProperties": false,
      "properties": {
        "additionalPrice": {
          "maximum": 100000000,
          "minimum": 0,
          "type": "integer"
        },
        "bundles": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "count": {
                "maximum": 10000,
                "minimum": 1,
                "type": "integer"
              },
              "price": {
                "maximum": 100000000,
                "minimum": 0,
                "type": "integer"
              }
            },
            "required": [
              "count",
              "price"
            ],
            "type": "object"
          },
          "maxItems": 20,
          "type": "array"
        },
        "collectionPrice": {
          "maximum": 100000000,
          "minimum": 0,
          "nullable": true,
          "type": "integer"
        },
        "currency": {
          "pattern": "^[A-Z]{3}$",
          "type": "string"
        },
        "downloadOutputs": {
          "items": {
            "additionalProperties": false,
            "properties": {
              "key": {
                "pattern": "^[a-z][a-z0-9-]{0,39}$",
                "type": "string"
              },
              "kind": {
                "enum": [
                  "print",
                  "web",
                  "social"
                ],
                "type": "string"
              },
              "label": {
                "maxLength": 100,
                "minLength": 1,
                "type": "string"
              },
              "maxEdge": {
                "maximum": 65535,
                "minimum": 320,
                "type": "integer"
              },
              "watermark": {
                "additionalProperties": false,
                "nullable": true,
                "properties": {
                  "alignment": {
                    "default": "center",
                    "enum": [
                      "left",
                      "center",
                      "right"
                    ],
                    "type": "string"
                  },
                  "backing": {
                    "default": false,
                    "type": "boolean"
                  },
                  "color": {
                    "default": "#ffffff",
                    "pattern": "^#[\\da-fA-F]{6}$",
                    "type": "string"
                  },
                  "font": {
                    "default": "script",
                    "enum": [
                      "script",
                      "serif",
                      "sans"
                    ],
                    "type": "string"
                  },
                  "logoAssetId": {
                    "default": null,
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "logoPosition": {
                    "default": "above",
                    "enum": [
                      "above",
                      "below",
                      "left",
                      "right"
                    ],
                    "type": "string"
                  },
                  "logoScale": {
                    "default": 1,
                    "maximum": 4,
                    "minimum": 0.25,
                    "type": "number"
                  },
                  "logoVariant": {
                    "default": "original",
                    "enum": [
                      "original",
                      "light",
                      "dark"
                    ],
                    "type": "string"
                  },
                  "margin": {
                    "default": 4,
                    "maximum": 25,
                    "minimum": 0,
                    "type": "number"
                  },
                  "opacity": {
                    "default": 45,
                    "maximum": 100,
                    "minimum": 1,
                    "type": "number"
                  },
                  "outline": {
                    "default": false,
                    "type": "boolean"
                  },
                  "pattern": {
                    "default": "signature",
                    "enum": [
                      "signature",
                      "centre",
                      "diagonal",
                      "tile"
                    ],
                    "type": "string"
                  },
                  "position": {
                    "default": "bottom-right",
                    "enum": [
                      "top-left",
                      "top-right",
                      "bottom-left",
                      "bottom-right",
                      "center"
                    ],
                    "type": "string"
                  },
                  "rotation": {
                    "default": 0,
                    "maximum": 180,
                    "minimum": -180,
                    "type": "number"
                  },
                  "secondLine": {
                    "default": "",
                    "maxLength": 200,
                    "type": "string"
                  },
                  "size": {
                    "default": 6,
                    "maximum": 30,
                    "minimum": 1,
                    "type": "number"
                  },
                  "spacing": {
                    "default": 6,
                    "maximum": 100,
                    "minimum": 0,
                    "type": "number"
                  },
                  "text": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string"
                  },
                  "type": {
                    "default": "text",
                    "enum": [
                      "text",
                      "logo",
                      "both"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "text"
                ],
                "type": "object"
              }
            },
            "required": [
              "key",
              "label",
              "kind",
              "maxEdge",
              "watermark"
            ],
            "type": "object"
          },
          "maxItems": 6,
          "minItems": 1,
          "type": "array"
        },
        "downloadWatermark": {
          "additionalProperties": false,
          "nullable": true,
          "properties": {
            "alignment": {
              "default": "center",
              "enum": [
                "left",
                "center",
                "right"
              ],
              "type": "string"
            },
            "backing": {
              "default": false,
              "type": "boolean"
            },
            "color": {
              "default": "#ffffff",
              "pattern": "^#[\\da-fA-F]{6}$",
              "type": "string"
            },
            "font": {
              "default": "script",
              "enum": [
                "script",
                "serif",
                "sans"
              ],
              "type": "string"
            },
            "logoAssetId": {
              "default": null,
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "logoPosition": {
              "default": "above",
              "enum": [
                "above",
                "below",
                "left",
                "right"
              ],
              "type": "string"
            },
            "logoScale": {
              "default": 1,
              "maximum": 4,
              "minimum": 0.25,
              "type": "number"
            },
            "logoVariant": {
              "default": "original",
              "enum": [
                "original",
                "light",
                "dark"
              ],
              "type": "string"
            },
            "margin": {
              "default": 4,
              "maximum": 25,
              "minimum": 0,
              "type": "number"
            },
            "opacity": {
              "default": 45,
              "maximum": 100,
              "minimum": 1,
              "type": "number"
            },
            "outline": {
              "default": false,
              "type": "boolean"
            },
            "pattern": {
              "default": "signature",
              "enum": [
                "signature",
                "centre",
                "diagonal",
                "tile"
              ],
              "type": "string"
            },
            "position": {
              "default": "bottom-right",
              "enum": [
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
                "center"
              ],
              "type": "string"
            },
            "rotation": {
              "default": 0,
              "maximum": 180,
              "minimum": -180,
              "type": "number"
            },
            "secondLine": {
              "default": "",
              "maxLength": 200,
              "type": "string"
            },
            "size": {
              "default": 6,
              "maximum": 30,
              "minimum": 1,
              "type": "number"
            },
            "spacing": {
              "default": 6,
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "text": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "default": "text",
              "enum": [
                "text",
                "logo",
                "both"
              ],
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        },
        "expiresAt": {
          "format": "date-time",
          "nullable": true,
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
          "type": "string"
        },
        "includedCount": {
          "maximum": 10000,
          "minimum": 0,
          "type": "integer"
        },
        "mode": {
          "enum": [
            "edited-delivery",
            "select-before-editing",
            "sell-by-photo"
          ],
          "type": "string"
        },
        "paymentTiming": {
          "enum": [
            "before-editing",
            "after-approval"
          ],
          "type": "string"
        },
        "presentation": {
          "additionalProperties": false,
          "properties": {
            "blocks": {
              "items": {
                "additionalProperties": false,
                "properties": {
                  "captureIds": {
                    "items": {
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                      "type": "string"
                    },
                    "maxItems": 1000,
                    "type": "array"
                  },
                  "chapterId": {
                    "format": "uuid",
                    "nullable": true,
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "id": {
                    "format": "uuid",
                    "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
                    "type": "string"
                  },
                  "selection": {
                    "enum": [
                      "automatic",
                      "explicit"
                    ],
                    "type": "string"
                  },
                  "text": {
                    "maxLength": 2000,
                    "type": "string"
                  },
                  "type": {
                    "enum": [
                      "chapter",
                      "grid",
                      "full",
                      "pair",
                      "caption",
                      "slideshow"
                    ],
                    "type": "string"
                  }
                },
                "required": [
                  "id",
                  "type",
                  "chapterId",
                  "captureIds",
                  "text"
                ],
                "type": "object"
              },
              "maxItems": 100,
              "type": "array"
            },
            "coverCaptureId": {
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "coverFocal": {
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "coverTreatment": {
              "enum": [
                "full",
                "split",
                "quiet"
              ],
              "type": "string"
            },
            "font": {
              "enum": [
                "editorial",
                "modern",
                "script"
              ],
              "type": "string"
            },
            "introduction": {
              "maxLength": 5000,
              "type": "string"
            },
            "palette": {
              "enum": [
                "studio",
                "ivory",
                "charcoal"
              ],
              "type": "string"
            },
            "showChapters": {
              "type": "boolean"
            },
            "showNumbers": {
              "type": "boolean"
            },
            "spacing": {
              "enum": [
                "compact",
                "comfortable",
                "airy"
              ],
              "type": "string"
            },
            "template": {
              "enum": [
                "wedding",
                "portrait",
                "fine-art",
                "proofing"
              ],
              "type": "string"
            }
          },
          "required": [
            "template",
            "coverCaptureId",
            "coverTreatment",
            "coverFocal",
            "font",
            "palette",
            "spacing",
            "introduction",
            "showChapters",
            "showNumbers"
          ],
          "type": "object"
        },
        "proofWatermark": {
          "additionalProperties": false,
          "properties": {
            "alignment": {
              "default": "center",
              "enum": [
                "left",
                "center",
                "right"
              ],
              "type": "string"
            },
            "backing": {
              "default": false,
              "type": "boolean"
            },
            "color": {
              "default": "#ffffff",
              "pattern": "^#[\\da-fA-F]{6}$",
              "type": "string"
            },
            "font": {
              "default": "script",
              "enum": [
                "script",
                "serif",
                "sans"
              ],
              "type": "string"
            },
            "logoAssetId": {
              "default": null,
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "logoPosition": {
              "default": "above",
              "enum": [
                "above",
                "below",
                "left",
                "right"
              ],
              "type": "string"
            },
            "logoScale": {
              "default": 1,
              "maximum": 4,
              "minimum": 0.25,
              "type": "number"
            },
            "logoVariant": {
              "default": "original",
              "enum": [
                "original",
                "light",
                "dark"
              ],
              "type": "string"
            },
            "margin": {
              "default": 4,
              "maximum": 25,
              "minimum": 0,
              "type": "number"
            },
            "opacity": {
              "default": 45,
              "maximum": 100,
              "minimum": 1,
              "type": "number"
            },
            "outline": {
              "default": false,
              "type": "boolean"
            },
            "pattern": {
              "default": "signature",
              "enum": [
                "signature",
                "centre",
                "diagonal",
                "tile"
              ],
              "type": "string"
            },
            "position": {
              "default": "bottom-right",
              "enum": [
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
                "center"
              ],
              "type": "string"
            },
            "rotation": {
              "default": 0,
              "maximum": 180,
              "minimum": -180,
              "type": "number"
            },
            "secondLine": {
              "default": "",
              "maxLength": 200,
              "type": "string"
            },
            "size": {
              "default": 6,
              "maximum": 30,
              "minimum": 1,
              "type": "number"
            },
            "spacing": {
              "default": 6,
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "text": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "default": "text",
              "enum": [
                "text",
                "logo",
                "both"
              ],
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        },
        "selectionDeadline": {
          "format": "date-time",
          "nullable": true,
          "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
          "type": "string"
        },
        "terms": {
          "maxLength": 5000,
          "type": "string"
        },
        "title": {
          "maxLength": 200,
          "minLength": 1,
          "type": "string"
        },
        "turnaroundDays": {
          "maximum": 365,
          "minimum": 0,
          "type": "integer"
        },
        "webWatermark": {
          "additionalProperties": false,
          "nullable": true,
          "properties": {
            "alignment": {
              "default": "center",
              "enum": [
                "left",
                "center",
                "right"
              ],
              "type": "string"
            },
            "backing": {
              "default": false,
              "type": "boolean"
            },
            "color": {
              "default": "#ffffff",
              "pattern": "^#[\\da-fA-F]{6}$",
              "type": "string"
            },
            "font": {
              "default": "script",
              "enum": [
                "script",
                "serif",
                "sans"
              ],
              "type": "string"
            },
            "logoAssetId": {
              "default": null,
              "format": "uuid",
              "nullable": true,
              "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
              "type": "string"
            },
            "logoPosition": {
              "default": "above",
              "enum": [
                "above",
                "below",
                "left",
                "right"
              ],
              "type": "string"
            },
            "logoScale": {
              "default": 1,
              "maximum": 4,
              "minimum": 0.25,
              "type": "number"
            },
            "logoVariant": {
              "default": "original",
              "enum": [
                "original",
                "light",
                "dark"
              ],
              "type": "string"
            },
            "margin": {
              "default": 4,
              "maximum": 25,
              "minimum": 0,
              "type": "number"
            },
            "opacity": {
              "default": 45,
              "maximum": 100,
              "minimum": 1,
              "type": "number"
            },
            "outline": {
              "default": false,
              "type": "boolean"
            },
            "pattern": {
              "default": "signature",
              "enum": [
                "signature",
                "centre",
                "diagonal",
                "tile"
              ],
              "type": "string"
            },
            "position": {
              "default": "bottom-right",
              "enum": [
                "top-left",
                "top-right",
                "bottom-left",
                "bottom-right",
                "center"
              ],
              "type": "string"
            },
            "rotation": {
              "default": 0,
              "maximum": 180,
              "minimum": -180,
              "type": "number"
            },
            "secondLine": {
              "default": "",
              "maxLength": 200,
              "type": "string"
            },
            "size": {
              "default": 6,
              "maximum": 30,
              "minimum": 1,
              "type": "number"
            },
            "spacing": {
              "default": 6,
              "maximum": 100,
              "minimum": 0,
              "type": "number"
            },
            "text": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string"
            },
            "type": {
              "default": "text",
              "enum": [
                "text",
                "logo",
                "both"
              ],
              "type": "string"
            }
          },
          "required": [
            "text"
          ],
          "type": "object"
        }
      },
      "required": [
        "presentation",
        "title",
        "mode",
        "paymentTiming",
        "currency",
        "includedCount",
        "additionalPrice",
        "collectionPrice",
        "bundles",
        "terms",
        "selectionDeadline",
        "expiresAt",
        "turnaroundDays",
        "proofWatermark",
        "webWatermark",
        "downloadWatermark"
      ],
      "type": "object"
    },
    "expectedRevision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "config",
    "expectedRevision"
  ],
  "type": "object"
}
```
