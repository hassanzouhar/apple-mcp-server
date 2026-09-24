// EventKit helper for apple-mcp-server.
//
// Reads Calendar + Reminders through Apple's native EventKit framework instead
// of driving the apps over Apple Events (JXA), which costs one IPC round-trip
// per property and times out on large data sets. EventKit queries an indexed
// store and returns results in milliseconds.
//
// Protocol: argv[1] = command, JSON args on stdin, JSON result on stdout:
//   {"ok": true,  "value": <result>}   or   {"ok": false, "error": "<message>"}
//
// Build (with an embedded Info.plist so TCC shows a usage string and the binary
// can request Calendars/Reminders full access):
//   swiftc -O -framework EventKit -framework Foundation \
//     -sectcreate __TEXT __info_plist eventkit/Info.plist \
//     eventkit/helper.swift -o server/bin/eventkit-helper

import EventKit
import Foundation

// MARK: - I/O helpers

func fail(_ message: String) -> Never {
    let payload: [String: Any] = ["ok": false, "error": message]
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(data)
    }
    exit(0) // protocol-level error, not a process error
}

func succeed(_ value: Any) -> Never {
    let payload: [String: Any] = ["ok": true, "value": value]
    guard let data = try? JSONSerialization.data(withJSONObject: payload) else {
        fail("Failed to serialize result")
    }
    FileHandle.standardOutput.write(data)
    exit(0)
}

func readArgs() -> [String: Any] {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    if data.isEmpty { return [:] }
    guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        fail("Could not parse stdin JSON")
    }
    return obj
}

// MARK: - Date helpers

let isoFull: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()
let dateOnly: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
}()
let isoOut: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

func parseDate(_ s: Any?) -> Date? {
    guard let str = s as? String, !str.isEmpty else { return nil }
    if let d = isoFull.date(from: str) { return d }
    if let d = isoPlain.date(from: str) { return d }
    if let d = dateOnly.date(from: str) { return d }
    return nil
}

func isoString(_ d: Date?) -> Any {
    guard let d = d else { return NSNull() }
    return isoOut.string(from: d)
}

func dateFromComponents(_ comps: DateComponents?) -> Date? {
    guard let comps = comps else { return nil }
    return Calendar.current.date(from: comps)
}

func hexColor(_ cg: CGColor?) -> Any {
    guard let cg = cg, let comps = cg.components, comps.count >= 3 else { return NSNull() }
    let r = Int((comps[0] * 255).rounded())
    let g = Int((comps[1] * 255).rounded())
    let b = Int((comps[2] * 255).rounded())
    return String(format: "#%02X%02X%02X", r, g, b)
}

// MARK: - Authorization

let store = EKEventStore()

func requestAccess(_ entity: EKEntityType) {
    let sem = DispatchSemaphore(value: 0)
    var granted = false
    var failure: Error?
    let handler: (Bool, Error?) -> Void = { g, e in granted = g; failure = e; sem.signal() }
    if #available(macOS 14.0, *) {
        if entity == .event {
            store.requestFullAccessToEvents(completion: handler)
        } else {
            store.requestFullAccessToReminders(completion: handler)
        }
    } else {
        store.requestAccess(to: entity, completion: handler)
    }
    sem.wait()
    if let failure = failure { fail("EventKit access error: \(failure.localizedDescription)") }
    if !granted {
        let name = entity == .event ? "Calendars" : "Reminders"
        fail("macOS denied \(name) access. Grant it under System Settings → Privacy & Security → \(name) for 'eventkit-helper'.")
    }
}

// MARK: - Serializers

func eventDict(_ e: EKEvent) -> [String: Any] {
    return [
        "id": e.eventIdentifier ?? "",
        "summary": e.title ?? "",
        "startDate": isoString(e.startDate),
        "endDate": isoString(e.endDate),
        "allDay": e.isAllDay,
        "location": e.location ?? NSNull(),
        "description": e.notes ?? NSNull(),
        "calendarName": e.calendar?.title ?? "",
        "url": e.url?.absoluteString ?? NSNull(),
    ]
}

func reminderDict(_ r: EKReminder) -> [String: Any] {
    let due = dateFromComponents(r.dueDateComponents)
    let remind = r.alarms?.first?.absoluteDate
    return [
        "id": r.calendarItemIdentifier,
        "name": r.title ?? "",
        "body": r.notes ?? NSNull(),
        "completed": r.isCompleted,
        "completionDate": isoString(r.completionDate),
        "dueDate": isoString(due),
        "remindMeDate": isoString(remind),
        "priority": r.priority,
        "flagged": false, // EventKit does not expose the flagged attribute
        "listName": r.calendar?.title ?? "",
    ]
}

// MARK: - Calendar lookups

func eventCalendar(named name: String) -> EKCalendar? {
    return store.calendars(for: .event).first { $0.title == name }
}
func reminderCalendar(named name: String) -> EKCalendar? {
    return store.calendars(for: .reminder).first { $0.title == name }
}

// MARK: - Reminders fetch (async → sync)

func fetchReminders(_ predicate: NSPredicate) -> [EKReminder] {
    let sem = DispatchSemaphore(value: 0)
    var result: [EKReminder] = []
    store.fetchReminders(matching: predicate) { rems in
        result = rems ?? []
        sem.signal()
    }
    sem.wait()
    return result
}

// MARK: - Commands

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let args = readArgs()

func intArg(_ key: String, _ fallback: Int) -> Int {
    if let n = args[key] as? Int { return n }
    if let n = args[key] as? NSNumber { return n.intValue }
    return fallback
}
func strArg(_ key: String) -> String? { return args[key] as? String }
func boolArg(_ key: String, _ fallback: Bool) -> Bool { return args[key] as? Bool ?? fallback }

switch command {

case "auth-status":
    let ev = EKEventStore.authorizationStatus(for: .event).rawValue
    let rem = EKEventStore.authorizationStatus(for: .reminder).rawValue
    succeed(["events": ev, "reminders": rem])

case "list-calendars":
    requestAccess(.event)
    let cals = store.calendars(for: .event).map { c -> [String: Any] in
        [
            "id": c.calendarIdentifier,
            "name": c.title,
            "description": NSNull(),
            "writable": c.allowsContentModifications,
            "color": hexColor(c.cgColor),
        ]
    }
    succeed(cals)

case "list-reminder-lists":
    requestAccess(.reminder)
    let lists = store.calendars(for: .reminder).map { ["id": $0.calendarIdentifier, "name": $0.title] }
    succeed(lists)

case "list-events":
    requestAccess(.event)
    guard let start = parseDate(args["startIso"]), let end = parseDate(args["endIso"]) else {
        fail("list-events requires startIso and endIso")
    }
    var calendars: [EKCalendar]? = nil
    if let name = strArg("calendarName") {
        guard let cal = eventCalendar(named: name) else { fail("Calendar not found: \(name)") }
        calendars = [cal]
    }
    let limit = intArg("limit", 100)
    let predicate = store.predicateForEvents(withStart: start, end: end, calendars: calendars)
    let events = store.events(matching: predicate)
        .sorted { ($0.startDate ?? .distantPast) < ($1.startDate ?? .distantPast) }
        .prefix(limit)
        .map(eventDict)
    succeed(Array(events))

case "get-event":
    requestAccess(.event)
    guard let id = strArg("id") else { fail("get-event requires id") }
    if let e = store.event(withIdentifier: id) { succeed(eventDict(e)) } else { succeed(NSNull()) }

case "create-event":
    requestAccess(.event)
    guard let name = strArg("calendarName"), let cal = eventCalendar(named: name) else {
        fail("Calendar not found: \(strArg("calendarName") ?? "(none)")")
    }
    guard let start = parseDate(args["startIso"]), let end = parseDate(args["endIso"]) else {
        fail("create-event requires startIso and endIso")
    }
    let e = EKEvent(eventStore: store)
    e.calendar = cal
    e.title = strArg("summary") ?? ""
    e.startDate = start
    e.endDate = end
    e.isAllDay = boolArg("allDay", false)
    if let loc = strArg("location") { e.location = loc }
    if let notes = strArg("description") { e.notes = notes }
    if let u = strArg("url"), let url = URL(string: u) { e.url = url }
    do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("Save failed: \(error.localizedDescription)") }
    succeed(["id": e.eventIdentifier ?? ""])

case "update-event":
    requestAccess(.event)
    guard let id = strArg("id"), let e = store.event(withIdentifier: id) else { fail("Event not found") }
    if let v = strArg("summary") { e.title = v }
    if let d = parseDate(args["startIso"]) { e.startDate = d }
    if let d = parseDate(args["endIso"]) { e.endDate = d }
    if let b = args["allDay"] as? Bool { e.isAllDay = b }
    if let v = strArg("location") { e.location = v }
    if let v = strArg("description") { e.notes = v }
    if let u = strArg("url"), let url = URL(string: u) { e.url = url }
    do { try store.save(e, span: .thisEvent, commit: true) } catch { fail("Save failed: \(error.localizedDescription)") }
    succeed(["updated": true])

case "delete-event":
    requestAccess(.event)
    guard let id = strArg("id"), let e = store.event(withIdentifier: id) else { fail("Event not found") }
    do { try store.remove(e, span: .thisEvent, commit: true) } catch { fail("Delete failed: \(error.localizedDescription)") }
    succeed(["deleted": true])

case "list-reminders":
    requestAccess(.reminder)
    var calendars: [EKCalendar]? = nil
    if let name = strArg("listName") {
        guard let cal = reminderCalendar(named: name) else { fail("Reminder list not found: \(name)") }
        calendars = [cal]
    }
    let includeCompleted = boolArg("includeCompleted", false)
    let dueBefore = parseDate(args["dueBeforeIso"])
    let dueAfter = parseDate(args["dueAfterIso"])
    let query = (strArg("query") ?? "").lowercased()
    let limit = intArg("limit", 25)
    let predicate = store.predicateForReminders(in: calendars)
    var rems = fetchReminders(predicate)
    if !includeCompleted { rems = rems.filter { !$0.isCompleted } }
    if dueBefore != nil || dueAfter != nil {
        rems = rems.filter { r in
            guard let due = dateFromComponents(r.dueDateComponents) else { return false }
            if let b = dueBefore, !(due < b) { return false }
            if let a = dueAfter, !(due >= a) { return false }
            return true
        }
    }
    if !query.isEmpty {
        rems = rems.filter {
            ($0.title ?? "").lowercased().contains(query) ||
            ($0.notes ?? "").lowercased().contains(query)
        }
    }
    let out = rems
        .sorted { (dateFromComponents($0.dueDateComponents) ?? .distantFuture) < (dateFromComponents($1.dueDateComponents) ?? .distantFuture) }
        .prefix(limit)
        .map(reminderDict)
    succeed(Array(out))

case "create-reminder":
    requestAccess(.reminder)
    guard let name = strArg("listName"), let cal = reminderCalendar(named: name) else {
        fail("Reminder list not found: \(strArg("listName") ?? "(none)")")
    }
    let r = EKReminder(eventStore: store)
    r.calendar = cal
    r.title = strArg("name") ?? ""
    if let notes = strArg("body") { r.notes = notes }
    if let due = parseDate(args["dueIso"]) {
        r.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second], from: due)
    }
    if let remind = parseDate(args["remindIso"]) { r.addAlarm(EKAlarm(absoluteDate: remind)) }
    if let p = args["priority"] as? Int { r.priority = p }
    do { try store.save(r, commit: true) } catch { fail("Save failed: \(error.localizedDescription)") }
    succeed(["id": r.calendarItemIdentifier])

case "update-reminder":
    requestAccess(.reminder)
    guard let id = strArg("id"),
          let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("Reminder not found") }
    if let v = strArg("name") { r.title = v }
    if let v = strArg("body") { r.notes = v }
    if let due = parseDate(args["dueIso"]) {
        r.dueDateComponents = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute, .second], from: due)
    }
    if let remind = parseDate(args["remindIso"]) { r.addAlarm(EKAlarm(absoluteDate: remind)) }
    if let p = args["priority"] as? Int { r.priority = p }
    do { try store.save(r, commit: true) } catch { fail("Save failed: \(error.localizedDescription)") }
    succeed(["updated": true])

case "complete-reminder":
    requestAccess(.reminder)
    guard let id = strArg("id"),
          let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("Reminder not found") }
    r.isCompleted = boolArg("completed", true)
    do { try store.save(r, commit: true) } catch { fail("Save failed: \(error.localizedDescription)") }
    succeed(["completed": r.isCompleted])

case "delete-reminder":
    requestAccess(.reminder)
    guard let id = strArg("id"),
          let r = store.calendarItem(withIdentifier: id) as? EKReminder else { fail("Reminder not found") }
    do { try store.remove(r, commit: true) } catch { fail("Delete failed: \(error.localizedDescription)") }
    succeed(["deleted": true])

case "create-reminder-list":
    requestAccess(.reminder)
    let cal = EKCalendar(for: .reminder, eventStore: store)
    cal.title = strArg("name") ?? ""
    guard let source = store.defaultCalendarForNewReminders()?.source
            ?? store.sources.first(where: { $0.sourceType == .local })
            ?? store.sources.first else {
        fail("No reminder source available to create a list")
    }
    cal.source = source
    do { try store.saveCalendar(cal, commit: true) } catch { fail("Create failed: \(error.localizedDescription)") }
    succeed(["id": cal.calendarIdentifier])

default:
    fail("Unknown command: \(command)")
}
