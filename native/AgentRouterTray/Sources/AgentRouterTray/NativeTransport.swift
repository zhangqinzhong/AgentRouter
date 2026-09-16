import Foundation
actor NativeTransport {
 static let shared = NativeTransport()
 private var pending: [String: CheckedContinuation<Data, Error>] = [:]
 func request(_ path: String, query: [URLQueryItem] = []) async throws -> Data {
  let id = UUID().uuidString
  return try await withCheckedThrowingContinuation { continuation in
   pending[id] = continuation
   let query = Dictionary(query.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { _,b in b })
   let data = try! JSONSerialization.data(withJSONObject:["event":"request","id":id,"path":path,"query":query])
   FileHandle.standardOutput.write(data + Data([10]))
   Task { try? await Task.sleep(nanoseconds: 30_000_000_000); self.timeout(id) }
  }
 }
 private func timeout(_ id: String) { pending.removeValue(forKey:id)?.resume(throwing:URLError(.timedOut)) }
 func receive(_ data: Data) {
  guard let object = try? JSONSerialization.jsonObject(with:data) as? [String:Any],let id=object["id"] as? String,let continuation=pending.removeValue(forKey:id) else { return }
  if let error=object["error"] as? String { continuation.resume(throwing:NSError(domain:"AgentRouter",code:1,userInfo:[NSLocalizedDescriptionKey:error]));return }
  do { continuation.resume(returning:try JSONSerialization.data(withJSONObject:object["data"] ?? [:],options:[.fragmentsAllowed])) } catch { continuation.resume(throwing:error) }
 }
}
