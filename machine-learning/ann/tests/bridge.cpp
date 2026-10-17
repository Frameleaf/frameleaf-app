#include <cassert>
#include <string>
#include "../ann.cpp"

int main(int argc, char** argv) {
    assert(argc == 2);
    const std::string test = argv[1];
    if (test == "ownership-and-abi") {
        void* handle = init(0, 1, nullptr);
        int id = load(handle, "fixture.armnn", true, false, false, nullptr);
        assert(id >= 0);
        assert(tensors(handle, id, true) == 1 && tensors(handle, id, false) == 1);
        assert(shape(handle, id, true, 0) == 0x00020001UL);
        float input[] = {0.25F, -0.75F}, output[] = {0, 0};
        const void* inputs[] = {input};
        void* outputs[] = {output};
        execute(handle, id, inputs, outputs);
        assert(output[0] == input[0] && output[1] == input[1]);
        unload(handle, id);
        destroy(handle);
        assert(fixture::runtimes == 0 && fixture::parsers == 0);
    } else {
        Ann ann(1, nullptr);
        if (test == "load-exception") {
            fixture::failLoad = true;
            assert(ann.load("fixture.armnn", true, true, false, nullptr) >= 0);
        } else {
            int id = ann.load("fixture.armnn", true, false, false, nullptr);
            if (test == "execute-exception") {
                float input[] = {1, 2}, output[] = {0, 0};
                const void* inputs[] = {input}; void* outputs[] = {output};
                fixture::failExecute = true;
                try { ann.execute(id, inputs, outputs); assert(false); } catch (const std::runtime_error&) {}
                ann.execute(id, inputs, outputs);
                assert(output[0] == 1 && output[1] == 2);
            } else if (test == "unload-exception") {
                fixture::failUnload = true;
                try { ann.unload(id); assert(false); } catch (const std::runtime_error&) {}
                assert(ann.load("fixture.armnn", true, false, false, nullptr) >= 0);
            } else { assert(false); }
        }
        assert(fixture::parsers == 0);
    }
}
