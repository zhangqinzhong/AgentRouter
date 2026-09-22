import XCTest
@testable import AgentRouterTray

final class PetCharacterTests: XCTestCase {
    func testHashUsesRawValueAndDoesNotRecurse() {
        let cases = PetCharacter.allCases
        XCTAssertFalse(cases.isEmpty)

        var seen = Set<PetCharacter>()
        for character in cases {
            var hasher = Hasher()
            character.hash(into: &hasher)
            _ = hasher.finalize()
            seen.insert(character)
        }

        XCTAssertEqual(seen.count, cases.count)
        XCTAssertEqual(PetCharacter(rawValue: "clawd"), .clawd)
        XCTAssertNotEqual(PetCharacter.clawd, .bot)
        XCTAssertEqual(PetCharacter.clawd.hashValue, PetCharacter(rawValue: "clawd")?.hashValue)
    }

    func testDragTranslationUsesScreenCoordinates() {
        let drag = PetDragTranslation(
            anchorMouse: CGPoint(x: 100, y: 200),
            anchorOrigin: CGPoint(x: 10, y: 20)
        )

        XCTAssertFalse(drag.movedFarEnough(to: CGPoint(x: 101, y: 201)))
        XCTAssertTrue(drag.movedFarEnough(to: CGPoint(x: 104, y: 200)))

        let origin = drag.origin(at: CGPoint(x: 130, y: 250))
        XCTAssertEqual(origin.x, 40)
        XCTAssertEqual(origin.y, 70)
    }
}
