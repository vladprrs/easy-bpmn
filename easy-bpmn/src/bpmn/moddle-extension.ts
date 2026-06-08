// The ONLY notation easy-bpmn adds: a moddle descriptor for the
// <easy-bpmn:taskDefinition type="…" retries="…"/> element carried inside the
// standard <bpmn:extensionElements>. It is additive and ignorable — a standard
// modeler that ignores the easy-bpmn namespace still round-trips the file.
//
// `type`    = stable worker routing key (NOT the element id/name).
// `retries` = per-Service-Task retry limit.

export const EASY_BPMN_NS = "http://easy-bpmn/schema/1.0";
export const EASY_BPMN_PREFIX = "easy-bpmn";

export const easyBpmnModdle = {
  name: "easyBpmn",
  uri: EASY_BPMN_NS,
  prefix: EASY_BPMN_PREFIX,
  xml: { tagAlias: "lowerCase" },
  types: [
    {
      name: "TaskDefinition",
      // A child of bpmn:ExtensionElements (whose values are bpmn:Element).
      superClass: ["Element"],
      properties: [
        { name: "type", isAttr: true, type: "String" },
        { name: "retries", isAttr: true, type: "String" },
      ],
    },
  ],
} as const;

/** The moddle $type produced for the extension element above. */
export const TASK_DEFINITION_TYPE = "easy-bpmn:TaskDefinition";
