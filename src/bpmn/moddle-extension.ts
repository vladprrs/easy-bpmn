// The ONLY notation easy-bpmn adds: moddle descriptors for the easy-bpmn
// elements carried inside the standard <bpmn:extensionElements>. They are
// additive and ignorable — a standard modeler that ignores the easy-bpmn
// namespace still round-trips the file.
//
// <easy-bpmn:taskDefinition type="…" retries="…"/>
//   `type`    = stable worker routing key (NOT the element id/name).
//   `retries` = per-Service-Task retry limit.
//
// <easy-bpmn:multiInstance collection="…" elementVariable="…" outputVariable="…"/>
//   M5-L3: the collection cardinality source for multiInstanceLoopCharacteristics
//   (the standard-notation data bindings — loopDataInputRef/inputDataItem — are
//   permanently out of profile). `collection` = list-valued FEEL; `elementVariable`
//   = per-iteration item variable (default "item"); `outputVariable` = aggregation
//   target (aggregation only when present).

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
    {
      name: "MultiInstance",
      superClass: ["Element"],
      properties: [
        { name: "collection", isAttr: true, type: "String" },
        { name: "elementVariable", isAttr: true, type: "String" },
        { name: "outputVariable", isAttr: true, type: "String" },
      ],
    },
  ],
} as const;

/** The moddle $type produced for <easy-bpmn:taskDefinition>. */
export const TASK_DEFINITION_TYPE = "easy-bpmn:TaskDefinition";

/** The moddle $type produced for <easy-bpmn:multiInstance> (M5-L3). */
export const MULTI_INSTANCE_TYPE = "easy-bpmn:MultiInstance";
