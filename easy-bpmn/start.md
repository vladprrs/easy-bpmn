# 1-pager: Business Requirements — BPMN-lite Orchestrator MVP

## 1. Цель

Реализовать минимальный вертикальный слайс BPMN-lite оркестратора поверх Cloudflare stack, который доказывает, что пользователь может загрузить BPMN 2.0 compatible схему, запустить process instance, выполнить автоматический service task через удалённый worker, дождаться внешнего business event и завершить процесс с видимой историей исполнения.

## 2. Product Promise

Пользователь может исполнять простые BPMN-процессы без развёртывания собственного workflow-кластера, брокеров, Zeebe/Camunda-инфраструктуры и отдельного ops-стека.

Платформа берёт на себя:

* durable execution;
* хранение состояния процесса;
* вызов внешних service workers;
* ожидание внешних событий;
* correlation события с нужным process instance;
* базовую наблюдаемость и историю исполнения.

## 3. MVP BPMN Profile

Первый слайс поддерживает только стандартные BPMN-элементы:

```text
Start Event → Service Task → Receive Task → End Event
```

Поддерживаемые элементы:

* `Start Event` — старт процесса;
* `Service Task` — вызов удалённого worker’а;
* `Receive Task` — ожидание внешнего сообщения;
* `End Event` — завершение процесса;
* `Sequence Flow` — переходы между элементами;
* `Message` / correlation key — связь внешнего события с нужным process instance.

Важно: human task не реализуется внутри платформы. Действие человека происходит во внешней системе: админке, CRM, боте, back-office UI. Платформа получает только факт этого действия через BPMN-compatible message / receive task.

## 4. Основной сценарий

Пример процесса:

```text
Start
  → Run External Check
  → Wait for Approval Event
  → End
```

Сценарий:

1. Пользователь загружает BPMN XML.
2. Платформа валидирует, что схема входит в поддерживаемый BPMN subset.
3. Пользователь публикует immutable process definition version.
4. Пользователь запускает process instance с initial variables.
5. Runtime выполняет `Service Task`: вызывает удалённый worker по RPC/gRPC-like контракту.
6. Worker возвращает результат и output variables.
7. Runtime переходит в `Receive Task` и ждёт внешнее событие.
8. Внешняя админка/бот/CRM отправляет событие с correlation key.
9. Runtime находит нужный process instance, применяет payload события и завершает процесс.
10. Оператор видит статус, variables и историю исполнения.

## 5. Functional Requirements

1. Пользователь может загрузить BPMN XML через UI или API.
2. Система валидирует BPMN и отклоняет неподдерживаемые элементы.
3. Система публикует immutable process definition version.
4. Пользователь может запустить process instance от опубликованной версии.
5. Runtime вызывает remote service worker для `Service Task`.
6. Runtime сохраняет output variables от service worker.
7. Runtime переводит instance в ожидание `Receive Task`.
8. Внешняя система может отправить message/event через API.
9. Runtime correlates event по `messageName + correlationKey`.
10. Runtime продолжает и завершает process instance после получения события.
11. Оператор может увидеть статус instance, текущий BPMN element, variables и history.
12. Повторный callback, повторное событие или retry не должны ломать процесс.

## 6. Non-functional Requirements

* Опубликованные process definitions immutable.
* Running instances всегда связаны с конкретной process definition version.
* Внешние вызовы и события должны быть idempotent.
* Все ключевые state transitions должны сохраняться в audit history.
* Ошибки должны быть понятны пользователю: что произошло, на каком BPMN element, что можно сделать дальше.
* Первый demo-flow должен запускаться без настройки собственной инфраструктуры пользователем.

## 7. Out of Scope

В первый слайс не входят:

* встроенный tasklist;
* BPMN `User Task`;
* формы, assignment и управление задачами людей;
* gateways;
* timers;
* boundary events;
* subprocesses;
* multi-instance;
* compensation;
* process migration;
* полноценная совместимость с Zeebe/Camunda;
* visual BPMN modeler;
* advanced Operate UI.

## 8. Success Criteria

MVP считается успешным, если пользователь может пройти полный demo-flow:

```text
upload BPMN
→ publish version
→ start instance
→ execute service task via remote worker
→ wait for receive task message
→ correlate external event
→ complete process
→ inspect execution history
```

Ключевая проверка ценности: BPMN-схема становится исполняемым durable process без собственного workflow-кластера, при этом платформа остаётся в рамках стандартных BPMN 2.0 элементов и не придумывает собственную нотацию.
